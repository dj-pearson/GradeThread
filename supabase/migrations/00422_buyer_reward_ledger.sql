-- US-1813: buyer reward ledger + anti-abuse + redemption.
--
-- A verified grade confirmation (US-1812) earns the buyer reward CREDITS — a
-- second currency that redeems on metered buyer actions (authenticity / video
-- grades) once the monthly plan allowance is exhausted. That's the "buyer credit
-- balance" leg the US-1800 debit precedence anticipated (monthly allowance →
-- reward credits → upgrade), now filled.
--
-- Two service-write / owner-read tables:
--   buyer_reward_ledger   — append-only history (earn / redeem / reversal). The
--     UNIQUE (user_id, entry_type, reference_id) IS the idempotency ledger: a
--     retried issue for the same confirmation (reference_id = buyer_purchase_id)
--     is absorbed, never double-credited.
--   buyer_reward_credits  — the derived spendable balance (locked on write).
-- Three SECURITY DEFINER RPCs do the atomic work (issue / redeem / refund).
-- Reward economics are admin-tunable in system_settings (referral-config pattern).

-- ── ledger (append-only history + idempotency) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.buyer_reward_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entry_type    text NOT NULL CHECK (entry_type IN ('earn', 'redeem', 'reversal')),
  credits       integer NOT NULL,
  reason        text,
  -- Set on redeem/reversal: which meter the credit was spent on.
  meter         text,
  -- Idempotency handle from the producing domain (buyer_purchase_id on an earn;
  -- a random token on redeem/reversal so those never collide).
  reference_id  text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_buyer_reward_ledger_user
  ON public.buyer_reward_ledger (user_id, created_at DESC);
-- Serves the per-account/day anti-abuse cap count.
CREATE INDEX IF NOT EXISTS idx_buyer_reward_ledger_user_earn
  ON public.buyer_reward_ledger (user_id, created_at)
  WHERE entry_type = 'earn';

ALTER TABLE public.buyer_reward_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own reward ledger" ON public.buyer_reward_ledger;
CREATE POLICY "Users read own reward ledger"
  ON public.buyer_reward_ledger FOR SELECT USING (auth.uid() = user_id);

-- ── balance (derived, spendable) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.buyer_reward_credits (
  user_id           uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  balance           integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned   integer NOT NULL DEFAULT 0,
  lifetime_redeemed integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.buyer_reward_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own reward credits" ON public.buyer_reward_credits;
CREATE POLICY "Users read own reward credits"
  ON public.buyer_reward_credits FOR SELECT USING (auth.uid() = user_id);

-- ── issue (idempotent + day-capped) ─────────────────────────────────────────
-- Returns the credits actually issued: 0 when the confirmation was already
-- rewarded (idempotent) OR the per-account/day cap is hit. The FOR UPDATE lock
-- on the balance row serializes concurrent issues for the same buyer so the
-- dup-check + cap-check + insert are atomic (no double-issue, no cap bypass).
CREATE OR REPLACE FUNCTION public.issue_buyer_reward_credit(
  p_user_id uuid,
  p_reference_id text,
  p_credits int,
  p_daily_cap int
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today int;
BEGIN
  IF p_credits <= 0 THEN RETURN 0; END IF;

  INSERT INTO public.buyer_reward_credits(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.buyer_reward_credits WHERE user_id = p_user_id FOR UPDATE;

  -- Idempotent: this confirmation already earned.
  IF EXISTS (
    SELECT 1 FROM public.buyer_reward_ledger
    WHERE user_id = p_user_id AND entry_type = 'earn' AND reference_id = p_reference_id
  ) THEN
    RETURN 0;
  END IF;

  -- Per-account/day cap (0 = unlimited).
  IF p_daily_cap > 0 THEN
    SELECT count(*) INTO v_today FROM public.buyer_reward_ledger
      WHERE user_id = p_user_id AND entry_type = 'earn'
        AND created_at >= date_trunc('day', now());
    IF v_today >= p_daily_cap THEN RETURN 0; END IF;
  END IF;

  INSERT INTO public.buyer_reward_ledger(user_id, entry_type, credits, reason, reference_id)
    VALUES (p_user_id, 'earn', p_credits, 'grade_confirmation', p_reference_id);
  UPDATE public.buyer_reward_credits
    SET balance = balance + p_credits,
        lifetime_earned = lifetime_earned + p_credits,
        updated_at = now()
    WHERE user_id = p_user_id;
  RETURN p_credits;
END;
$$;

-- ── redeem (spend one credit on a meter) ────────────────────────────────────
-- Atomically decrement the balance by one and log the redemption. Returns false
-- when the buyer has no reward credits (so the caller falls through to the
-- upgrade prompt). Fail-CLOSED at the balance floor.
CREATE OR REPLACE FUNCTION public.redeem_buyer_reward_credit(
  p_user_id uuid,
  p_meter text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance int;
BEGIN
  SELECT balance INTO v_balance FROM public.buyer_reward_credits
    WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_balance <= 0 THEN RETURN false; END IF;

  UPDATE public.buyer_reward_credits
    SET balance = balance - 1,
        lifetime_redeemed = lifetime_redeemed + 1,
        updated_at = now()
    WHERE user_id = p_user_id;
  INSERT INTO public.buyer_reward_ledger(user_id, entry_type, credits, reason, meter, reference_id)
    VALUES (p_user_id, 'redeem', 1, 'meter_redemption', p_meter, gen_random_uuid()::text);
  RETURN true;
END;
$$;

-- ── refund (return a redeemed credit when the paid work failed) ──────────────
CREATE OR REPLACE FUNCTION public.refund_buyer_reward_credit(
  p_user_id uuid,
  p_meter text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.buyer_reward_credits(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.buyer_reward_credits
    SET balance = balance + 1,
        lifetime_redeemed = GREATEST(0, lifetime_redeemed - 1),
        updated_at = now()
    WHERE user_id = p_user_id;
  INSERT INTO public.buyer_reward_ledger(user_id, entry_type, credits, reason, meter, reference_id)
    VALUES (p_user_id, 'reversal', 1, 'meter_refund', p_meter, gen_random_uuid()::text);
END;
$$;

-- ── admin-tunable reward economics (referral-config pattern) ─────────────────
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'buyer.reward_config',
  jsonb_build_object(
    'credits_per_confirmation', 1,
    'daily_confirmation_cap', 5,
    'require_arrival_evidence', true
  ),
  'json',
  jsonb_build_object(
    'credits_per_confirmation', 1,
    'daily_confirmation_cap', 5,
    'require_arrival_evidence', true
  ),
  'buyer',
  'Buyer grade-confirmation reward economics (US-1813), read at issue time. '
  'credits_per_confirmation = reward credits earned per verified confirmation; '
  'daily_confirmation_cap = max rewarded confirmations per account/day (0 = unlimited); '
  'require_arrival_evidence = only reward confirmations that uploaded ≥1 arrival photo. '
  'Negative/invalid values are clamped.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00422')
ON CONFLICT (version) DO NOTHING;
