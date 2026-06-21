-- US-1113: buyer-guarantee claim → grading-accuracy calibration feedback loop.
--
-- An APPROVED buyer trust-guarantee claim (admin-claims.ts) is a confirmed
-- "the grade was wrong" ground-truth signal: the certified item was materially
-- WORSE than graded. Until now an approval ended at a status flip + audit log
-- and never reached the grading accuracy/calibration system. This table is the
-- durable substrate that closes the loop: each approved claim contributes ONE
-- per-factor over-grade signal (claimed_issues mapped to the five grading
-- factors), which the admin grading-calibration panel aggregates.
--
-- Provenance / lifecycle:
--   * One row per claim — UNIQUE(claim_id) makes the write idempotent so a claim
--     contributes exactly ONCE (no double-counting on re-approval).
--   * active = whether the claim is CURRENTLY approved. Rejecting/reversing a
--     previously-approved claim flips active=false (neutralizes the signal)
--     rather than deleting it, so the row's history survives and re-approval
--     re-activates it.
--
-- TENANT SAFETY (US-268): seller_user_id is the owning tenant, copied from the
-- already-ownership-verified guarantee_claims row (resolved server-side from the
-- public certificate, never the request). RLS is enabled with NO policies — this
-- is an operator/grading-quality surface read & written ONLY by the service-role
-- edge client (lib/accuracy-tracking.ts); a bare anon/authenticated PostgREST
-- client sees nothing. (The column is named seller_user_id, not user_id, so it
-- is not auto-discovered as client-readable tenant data — it is classified in
-- rls-guard_test.ts SERVICE_ROLE_ONLY instead.)
--
-- Idempotent (US-1108): IF NOT EXISTS table/index, ON CONFLICT seed-free, footer.

BEGIN;

CREATE TABLE IF NOT EXISTS public.claim_accuracy_signals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The approved claim this signal is derived from (one signal per claim).
  claim_id          uuid NOT NULL REFERENCES public.guarantee_claims(id) ON DELETE CASCADE,
  -- The graded report the claim disputes (the grade this signal corrects).
  grade_report_id   uuid NOT NULL REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  -- Submission + garment category for optional category slicing (best-effort).
  submission_id     uuid,
  garment_category  text,
  -- Owning tenant — copied from the verified guarantee_claims.seller_user_id.
  seller_user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Per-factor over-grade points implied by the approved claim's claimed_issues
  -- (factor -> summed severity weight). Shape mirrors the five grading factors.
  factor_deltas     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Rubric-weighted implied overall over-grade (how many points too high).
  overall_delta     numeric NOT NULL DEFAULT 0,
  -- Count of structured claimed_issues that mapped to a factor.
  issue_count       integer NOT NULL DEFAULT 0,
  -- Whether the claim is CURRENTLY approved (rejection/reversal -> false).
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One signal per claim — makes the apply write idempotent (no double-counting).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_claim_accuracy_signals_claim
  ON public.claim_accuracy_signals (claim_id);
-- The calibration aggregate scans only currently-approved signals.
CREATE INDEX IF NOT EXISTS idx_claim_accuracy_signals_active
  ON public.claim_accuracy_signals (active)
  WHERE active;
CREATE INDEX IF NOT EXISTS idx_claim_accuracy_signals_grade_report
  ON public.claim_accuracy_signals (grade_report_id);

COMMENT ON TABLE public.claim_accuracy_signals IS
  'US-1113 buyer-guarantee claim -> grading-accuracy feedback. One per-factor '
  'over-grade signal per APPROVED claim (UNIQUE claim_id = idempotent, once). '
  'active=false neutralizes a rejected/reversed claim. Service-role only (RLS on, '
  'no policies); seller_user_id is the owning tenant.';

-- updated_at auto-managed by the shared trigger (00001).
DROP TRIGGER IF EXISTS set_claim_accuracy_signals_updated_at ON public.claim_accuracy_signals;
CREATE TRIGGER set_claim_accuracy_signals_updated_at
  BEFORE UPDATE ON public.claim_accuracy_signals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS ON with NO permissive policies + explicit revoke: an operator/grading-
-- quality surface reached ONLY through the service-role edge client.
ALTER TABLE public.claim_accuracy_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.claim_accuracy_signals FROM anon, authenticated;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00302')
ON CONFLICT (version) DO NOTHING;
