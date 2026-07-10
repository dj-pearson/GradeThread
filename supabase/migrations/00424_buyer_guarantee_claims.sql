-- US-1821: insured "Grade-Locked" purchase-guarantee — claim intake + automated
-- remedy/payout.
--
-- A covered buyer (US-1819/1820) whose arrival was MATERIALLY below grade files a
-- claim. It pre-populates from the confirm evidence (US-1812: the buyer_arrival
-- grade_outcome already carries match_status/dispute_severity/overall_delta and
-- the guarantee_eligible flag) — no re-collection. The remedy is an ACCOUNT
-- CREDIT within the frozen coverage cap (there is no Stripe rail to a buyer who
-- paid a marketplace, so the payout is reward credits, granted immediately for an
-- auto-approved claim). The dollar figure is recorded for the US-1822 claims-pool
-- accounting; edge/ambiguous cases route to manual review (admin/claims).
--
-- Distinct from the SELLER grade-fee-back guarantee_claims (00197) — different
-- owner (buyer), different remedy (purchase-value credit, not grading-fee refund).

-- ── grant a non-confirmation reward credit (guarantee remedy payout) ─────────
-- Like issue_buyer_reward_credit but UNCAPPED and reason-tagged: the confirmation
-- day-cap must never block a guarantee remedy. Idempotent on reference_id.
CREATE OR REPLACE FUNCTION public.grant_buyer_reward_credit(
  p_user_id uuid,
  p_reference_id text,
  p_credits int,
  p_reason text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_credits <= 0 THEN RETURN 0; END IF;

  INSERT INTO public.buyer_reward_credits(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.buyer_reward_credits WHERE user_id = p_user_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.buyer_reward_ledger
    WHERE user_id = p_user_id AND entry_type = 'earn' AND reference_id = p_reference_id
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.buyer_reward_ledger(user_id, entry_type, credits, reason, reference_id)
    VALUES (p_user_id, 'earn', p_credits, p_reason, p_reference_id);
  UPDATE public.buyer_reward_credits
    SET balance = balance + p_credits,
        lifetime_earned = lifetime_earned + p_credits,
        updated_at = now()
    WHERE user_id = p_user_id;
  RETURN p_credits;
END;
$$;

-- The confirmation day-cap should only count CONFIRMATION earns, not remedy
-- grants — re-scope the cap count (same signature, body-only change).
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

  IF EXISTS (
    SELECT 1 FROM public.buyer_reward_ledger
    WHERE user_id = p_user_id AND entry_type = 'earn' AND reference_id = p_reference_id
  ) THEN
    RETURN 0;
  END IF;

  IF p_daily_cap > 0 THEN
    SELECT count(*) INTO v_today FROM public.buyer_reward_ledger
      WHERE user_id = p_user_id AND entry_type = 'earn'
        AND reason = 'grade_confirmation'
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

-- ── claim status ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyer_guarantee_claim_status') THEN
    CREATE TYPE public.buyer_guarantee_claim_status AS ENUM (
      'auto_approved', 'approved', 'manual_review', 'rejected', 'paid'
    );
  END IF;
END $$;

-- ── buyer_guarantee_claims ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.buyer_guarantee_claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- One claim per purchase (idempotency; re-filing returns the existing claim).
  purchase_id       uuid NOT NULL UNIQUE REFERENCES public.buyer_purchases(id) ON DELETE CASCADE,
  grade_report_id   uuid REFERENCES public.grade_reports(id) ON DELETE SET NULL,
  status            public.buyer_guarantee_claim_status NOT NULL DEFAULT 'manual_review',
  -- The confirm-evidence snapshot the decision rode on (audit + dispute defense).
  grade_delta       numeric,
  purchase_price_cents integer,
  payout_cap_cents  integer,
  -- The owed payout (for US-1822 pool accounting) + what was actually granted.
  remedy_cents      integer NOT NULL DEFAULT 0,
  remedy_credits    integer NOT NULL DEFAULT 0,
  auto              boolean NOT NULL DEFAULT false,
  decision_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buyer_guarantee_claims_user
  ON public.buyer_guarantee_claims (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_buyer_guarantee_claims_status
  ON public.buyer_guarantee_claims (status);

DROP TRIGGER IF EXISTS set_buyer_guarantee_claims_updated_at ON public.buyer_guarantee_claims;
CREATE TRIGGER set_buyer_guarantee_claims_updated_at
  BEFORE UPDATE ON public.buyer_guarantee_claims
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.buyer_guarantee_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Buyers read their own guarantee claims" ON public.buyer_guarantee_claims;
CREATE POLICY "Buyers read their own guarantee claims"
  ON public.buyer_guarantee_claims FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins read all buyer guarantee claims" ON public.buyer_guarantee_claims;
CREATE POLICY "Admins read all buyer guarantee claims"
  ON public.buyer_guarantee_claims FOR SELECT USING (public.is_admin());

-- ── admin-tunable remedy economics ──────────────────────────────────────────
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'buyer.guarantee_remedy',
  jsonb_build_object(
    'remedy_pct', 50,
    'flat_remedy_cents', 2500,
    'cents_per_credit', 500,
    'auto_max_cents', 10000,
    'auto_approve', true
  ),
  'json',
  jsonb_build_object(
    'remedy_pct', 50,
    'flat_remedy_cents', 2500,
    'cents_per_credit', 500,
    'auto_max_cents', 10000,
    'auto_approve', true
  ),
  'buyer',
  'Buyer purchase-guarantee remedy economics (US-1821), read at claim time. '
  'remedy_pct = %% of purchase price covered; flat_remedy_cents = remedy when the '
  'buyer did not record a price; cents_per_credit = $ value of one granted reward '
  'credit; auto_max_cents = remedies at/under this auto-approve, above route to '
  'manual review; auto_approve = master switch for automation. Capped by the '
  'purchase''s frozen payout_cap_cents. Negative/invalid values are clamped.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00424')
ON CONFLICT (version) DO NOTHING;
