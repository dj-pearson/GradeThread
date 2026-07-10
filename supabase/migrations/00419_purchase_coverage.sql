-- US-1820: insured "Grade-Locked" purchase guarantee — coverage & eligibility.
--
-- One SNAPSHOT row per linked purchase (US-1811) recording whether it is covered
-- and on what terms, resolved from the buyer's entitlement tier (US-1800) + Trust
-- Score level (US-1817) AT PURCHASE TIME and then FROZEN — a later downgrade
-- never voids an in-force claim (US-1820 AC2). Claim intake/payout is US-1821.
--
-- This is the NEW BUYER guarantee — DISTINCT from the seller-side grade-fee
-- `guarantee_claims` (00197, US-1276). OWNER-READ / SERVICE-WRITE (the edge
-- snapshots it when a purchase is linked, scoped by user_id, US-268); the buyer
-- sees their coverage but can't fabricate it.

CREATE TABLE IF NOT EXISTS public.purchase_coverage (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- One coverage record per purchase (re-link re-snapshots).
  purchase_id           uuid NOT NULL REFERENCES public.buyer_purchases(id) ON DELETE CASCADE,
  eligible              boolean NOT NULL DEFAULT false,
  -- Machine reason when ineligible (e.g. 'plan_not_covered'), null when eligible.
  ineligible_reason     text,
  -- Snapshotted resolution inputs (why this record has the terms it does).
  plan_at_purchase      text,
  level_at_purchase     smallint NOT NULL DEFAULT 0,
  -- Snapshotted terms: base window + reputation bonus (US-1817), payout cap, and
  -- the grade-delta threshold that qualifies a claim as a material mismatch.
  window_days           integer NOT NULL DEFAULT 0 CHECK (window_days >= 0),
  payout_cap_cents      integer NOT NULL DEFAULT 0 CHECK (payout_cap_cents >= 0),
  grade_delta_threshold numeric(3,1) NOT NULL DEFAULT 1.0,
  -- When the coverage lapses (null when ineligible). An in-force claim (US-1821)
  -- checks now() <= covered_until against THIS frozen value.
  covered_until         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_coverage_user ON public.purchase_coverage (user_id);

DROP TRIGGER IF EXISTS set_purchase_coverage_updated_at ON public.purchase_coverage;
CREATE TRIGGER set_purchase_coverage_updated_at
  BEFORE UPDATE ON public.purchase_coverage
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.purchase_coverage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own purchase coverage" ON public.purchase_coverage;
CREATE POLICY "Users read own purchase coverage"
  ON public.purchase_coverage FOR SELECT USING (auth.uid() = user_id);

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00419')
ON CONFLICT (version) DO NOTHING;
