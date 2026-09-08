-- US-3138: Action Credits, prepaid top-ups for metered actions.
--
-- A seller who exhausts their monthly AI-action allowance today has two
-- options: upgrade a tier or stop working until the month rolls over. This adds
-- a prepaid wallet that any metered action falls back to when its allowance is
-- empty. Design + pricing rationale: vault/50-business/action-credits.md and
-- docs/superpowers/specs/2026-09-07-action-credits-design.md.
--
-- Cloned from 00415 (api_credit_wallet), which is the proven shape here: a
-- FOR UPDATE debit plus an append-only ledger whose running SUM(delta) equals
-- balance_after on every row.
--
-- WHY ITS OWN TABLE and not a users column: 00526 made public.users
-- self-updates deny-by-default via an explicit allowlist, so a balance column
-- there would need the allowlist restated or every write is a silent no-op.
-- Mirrors buyer_meter_usage (00413) and api_credit_wallet (00415).
--
-- LOCK ORDER IS users THEN action_credit_wallet, everywhere, without exception.
-- reserve_ai_action_v2 takes the users row first and then calls
-- debit_action_credits, which takes the wallet row. Any future code that takes
-- them in the other order deadlocks against a concurrent reservation.
--
-- REFUND ROUTING IS LIFO, and that is why users gains a second counter.
-- refund_ai_action(p_user_id) is called from about thirty sites that have no
-- idea which source paid, so the function has to work it out. Credits are only
-- ever spent AFTER the allowance is exhausted, so if any credit-paid action
-- exists this month the most recent spend was a credit. One known imprecision:
-- a seller who upgrades mid-month after spending credits, then spends fresh
-- allowance, then fails, gets a credit back instead of an allowance slot. That
-- favors the seller, self-corrects, and is cheaper than threading a token
-- through every call site.

CREATE TABLE IF NOT EXISTS public.action_credit_wallet (
  user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  balance     integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only ledger. Running SUM(delta) oldest-first == balance_after on every
-- row, the same invariant lib/credit-ledger.ts proves for grade credits.
CREATE TABLE IF NOT EXISTS public.action_credit_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The ORDERING key, and it has to exist. created_at defaults to now(), which
  -- is TRANSACTION start time, so two ledger rows written in one transaction
  -- carry an identical timestamp and the running-sum invariant check cannot put
  -- them in order. That is not hypothetical: reserve_ai_action_v2 debits inside
  -- the same transaction as its caller. Order the ledger by seq, never by
  -- created_at.
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delta          integer NOT NULL,
  -- 'purchase' | 'debit' | 'refund' | 'clawback' | 'admin_grant'
  reason         text NOT NULL,
  -- 'ai_action' | 'connector_action', NULL on grants and clawbacks
  meter          text,
  -- 'stripe' | 'appstore' | 'googleplay' | 'admin' | 'meter'
  source         text NOT NULL DEFAULT 'meter',
  -- Stripe session id, App Store transaction id, or Play purchase token.
  external_id    text,
  balance_after  integer NOT NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Defensive: the CREATE TABLE above is IF NOT EXISTS, so a database that
-- already has the table from an earlier run of this file would not gain the
-- column from it.
ALTER TABLE public.action_credit_transactions
  ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;

CREATE INDEX IF NOT EXISTS idx_action_credit_tx_user_seq
  ON public.action_credit_transactions (user_id, seq DESC);

-- Idempotency for every storefront at once: one grant (and one clawback) per
-- external id per source. A replayed Stripe checkout.session.completed, a
-- re-presented StoreKit JWS and a duplicated Play RTDN all land here.
CREATE UNIQUE INDEX IF NOT EXISTS uq_action_credit_tx_external
  ON public.action_credit_transactions (source, reason, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE public.action_credit_wallet ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.action_credit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own action credit wallet" ON public.action_credit_wallet;
CREATE POLICY "Users read own action credit wallet"
  ON public.action_credit_wallet FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own action credit transactions" ON public.action_credit_transactions;
CREATE POLICY "Users read own action credit transactions"
  ON public.action_credit_transactions FOR SELECT USING (auth.uid() = user_id);

-- The LIFO refund counter. Rolls over with ai_actions_used_this_month, lazily,
-- inside reserve_ai_action_v2 -- nothing zeroes either column at midnight.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS ai_actions_credit_paid_this_month integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.users.ai_actions_credit_paid_this_month IS
  'US-3138: how many of this month''s AI actions were paid from the Action Credit wallet rather than the plan allowance. Lets refund_ai_action return a failed action to the source that actually paid for it.';

-- ── Wallet functions ────────────────────────────────────────────────

-- Add credits (a storefront purchase, or an admin grant). Idempotent on
-- (source, external_id): a replayed purchase notification grants once and
-- returns the balance it already produced. Returns the new balance.
CREATE OR REPLACE FUNCTION public.grant_action_credits(
  p_user_id uuid, p_credits int, p_reason text, p_source text,
  p_external_id text, p_notes text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_balance int;
BEGIN
  IF p_credits <= 0 THEN
    SELECT balance INTO v_balance FROM public.action_credit_wallet WHERE user_id = p_user_id;
    RETURN COALESCE(v_balance, 0);
  END IF;

  IF p_external_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.action_credit_transactions
     WHERE source = p_source AND reason = p_reason AND external_id = p_external_id
  ) THEN
    SELECT balance INTO v_balance FROM public.action_credit_wallet WHERE user_id = p_user_id;
    RETURN COALESCE(v_balance, 0);
  END IF;

  INSERT INTO public.action_credit_wallet(user_id, balance) VALUES (p_user_id, p_credits)
    ON CONFLICT (user_id) DO UPDATE
      SET balance = public.action_credit_wallet.balance + p_credits, updated_at = now()
    RETURNING balance INTO v_balance;

  INSERT INTO public.action_credit_transactions
    (user_id, delta, reason, source, external_id, balance_after, notes)
    VALUES (p_user_id, p_credits, p_reason, p_source, p_external_id, v_balance, p_notes);
  RETURN v_balance;
END;
$$;

-- Spend credits for one metered action. Returns the new balance, or -1 when the
-- wallet cannot cover it (the caller then refuses the action). Takes the wallet
-- row lock; see the LOCK ORDER note at the top of this file.
CREATE OR REPLACE FUNCTION public.debit_action_credits(
  p_user_id uuid, p_credits int, p_meter text, p_notes text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_balance int;
BEGIN
  IF p_credits <= 0 THEN RETURN -1; END IF;

  SELECT balance INTO v_balance
    FROM public.action_credit_wallet WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_balance < p_credits THEN RETURN -1; END IF;

  UPDATE public.action_credit_wallet
    SET balance = balance - p_credits, updated_at = now()
    WHERE user_id = p_user_id RETURNING balance INTO v_balance;

  INSERT INTO public.action_credit_transactions
    (user_id, delta, reason, meter, source, balance_after, notes)
    VALUES (p_user_id, -p_credits, 'debit', p_meter, 'meter', v_balance, p_notes);
  RETURN v_balance;
END;
$$;

-- Put a spent credit back when the work it paid for failed. Deliberately NOT
-- idempotent: each failed action refunds its own credit, and there is no
-- external id to key on.
CREATE OR REPLACE FUNCTION public.refund_action_credits(
  p_user_id uuid, p_credits int, p_meter text, p_notes text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_balance int;
BEGIN
  IF p_credits <= 0 THEN
    SELECT balance INTO v_balance FROM public.action_credit_wallet WHERE user_id = p_user_id;
    RETURN COALESCE(v_balance, 0);
  END IF;

  INSERT INTO public.action_credit_wallet(user_id, balance) VALUES (p_user_id, p_credits)
    ON CONFLICT (user_id) DO UPDATE
      SET balance = public.action_credit_wallet.balance + p_credits, updated_at = now()
    RETURNING balance INTO v_balance;

  INSERT INTO public.action_credit_transactions
    (user_id, delta, reason, meter, source, balance_after, notes)
    VALUES (p_user_id, p_credits, 'refund', p_meter, 'meter', v_balance, p_notes);
  RETURN v_balance;
END;
$$;

-- Take back credits granted for a purchase the buyer later refunded. Clamps at
-- zero: a seller who already spent them is not driven negative, which would
-- make the CHECK constraint reject the write and leave the clawback unrecorded.
-- Idempotent on (source, external_id) like the grant it reverses.
CREATE OR REPLACE FUNCTION public.clawback_action_credits(
  p_user_id uuid, p_credits int, p_source text, p_external_id text, p_notes text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_balance int;
  v_taken   int;
BEGIN
  IF p_credits <= 0 THEN
    SELECT balance INTO v_balance FROM public.action_credit_wallet WHERE user_id = p_user_id;
    RETURN COALESCE(v_balance, 0);
  END IF;

  IF p_external_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.action_credit_transactions
     WHERE source = p_source AND reason = 'clawback' AND external_id = p_external_id
  ) THEN
    SELECT balance INTO v_balance FROM public.action_credit_wallet WHERE user_id = p_user_id;
    RETURN COALESCE(v_balance, 0);
  END IF;

  SELECT balance INTO v_balance
    FROM public.action_credit_wallet WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_taken := least(p_credits, v_balance);
  UPDATE public.action_credit_wallet
    SET balance = balance - v_taken, updated_at = now()
    WHERE user_id = p_user_id RETURNING balance INTO v_balance;

  INSERT INTO public.action_credit_transactions
    (user_id, delta, reason, source, external_id, balance_after, notes)
    VALUES (p_user_id, -v_taken, 'clawback', p_source, p_external_id, v_balance, p_notes);
  RETURN v_balance;
END;
$$;

-- ── The AI reserve path ─────────────────────────────────────────────

-- Reserve one AI action: monthly allowance first, then the Action Credit
-- wallet, then refuse. Returns 'allowance' | 'credits' | 'exhausted'.
--
-- p_allow_credits is decided by the CALLER, not here, because checkQuota has
-- already collapsed the plan cap and the seller's self-imposed cap
-- (users.ai_action_limit) into one number by the time p_limit arrives. Hitting
-- your OWN limit must never silently spend money -- that limit exists to stop
-- runaway spend -- so the caller passes false when the self-cap is the binding
-- one. See lib/ai-quota.ts.
CREATE OR REPLACE FUNCTION public.reserve_ai_action_v2(
  p_user_id uuid, p_limit int, p_allow_credits boolean DEFAULT true
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_used        int;
  v_credit_used int;
  v_reset       timestamptz;
  v_rolled      boolean;
  v_balance     int;
BEGIN
  SELECT ai_actions_used_this_month,
         COALESCE(ai_actions_credit_paid_this_month, 0),
         ai_actions_reset_at
    INTO v_used, v_credit_used, v_reset
    FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'exhausted'; END IF;

  -- Lazy month rollover, identical to the predicate in lib/ai-metering.ts.
  v_rolled := date_trunc('month', v_reset) < date_trunc('month', now());
  IF v_rolled THEN
    v_used := 0;
    v_credit_used := 0;
  END IF;

  IF p_limit = -1 OR v_used < p_limit THEN
    UPDATE public.users
      SET ai_actions_used_this_month = v_used + 1,
          ai_actions_credit_paid_this_month = v_credit_used,
          ai_actions_reset_at = CASE WHEN v_rolled THEN now() ELSE ai_actions_reset_at END
      WHERE id = p_user_id;
    RETURN 'allowance';
  END IF;

  -- At the cap. Persist any rollover before deciding, so a refusal still leaves
  -- the stored counter correct (the behavior 00087 had).
  UPDATE public.users
    SET ai_actions_used_this_month = v_used,
        ai_actions_credit_paid_this_month = v_credit_used,
        ai_actions_reset_at = CASE WHEN v_rolled THEN now() ELSE ai_actions_reset_at END
    WHERE id = p_user_id;

  IF NOT COALESCE(p_allow_credits, true) THEN RETURN 'exhausted'; END IF;

  v_balance := public.debit_action_credits(
    p_user_id, 1, 'ai_action', 'monthly AI allowance exhausted');
  IF v_balance < 0 THEN RETURN 'exhausted'; END IF;

  UPDATE public.users
    SET ai_actions_credit_paid_this_month = v_credit_used + 1
    WHERE id = p_user_id;
  RETURN 'credits';
END;
$$;

-- The original two-argument signature, kept so an edge container still running
-- the previous build during a deploy keeps working. Credits allowed, which is
-- the correct default for every caller that predates the self-cap distinction.
CREATE OR REPLACE FUNCTION public.reserve_ai_action(p_user_id uuid, p_limit int)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.reserve_ai_action_v2(p_user_id, p_limit, true) <> 'exhausted';
$$;

-- Give a reserved action back when the work it paid for failed, to whichever
-- source actually paid. See the LIFO note at the top of this file.
CREATE OR REPLACE FUNCTION public.refund_ai_action(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_credit_used int;
BEGIN
  SELECT COALESCE(ai_actions_credit_paid_this_month, 0) INTO v_credit_used
    FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_credit_used > 0 THEN
    UPDATE public.users
      SET ai_actions_credit_paid_this_month = v_credit_used - 1
      WHERE id = p_user_id;
    PERFORM public.refund_action_credits(
      p_user_id, 1, 'ai_action', 'reserved AI action failed');
    RETURN;
  END IF;

  UPDATE public.users
    SET ai_actions_used_this_month = greatest(0, ai_actions_used_this_month - 1)
    WHERE id = p_user_id;
END;
$$;

-- DELIBERATELY NO REVOKE HERE, and that is not an oversight. On this Postgres
-- image a DENIED function call from anon or authenticated SEGFAULTS the backend
-- and restarts the whole database, because supautils appends a GRANT hint to
-- the error. That is why 00527, the bulk revoke across the schema, is parked as
-- .BLOCKED. The permission question belongs to US-2282/US-2403 and lands with
-- them, not smuggled into a wallet addition.

insert into public.applied_migrations (version) values ('00763') on conflict do nothing;
