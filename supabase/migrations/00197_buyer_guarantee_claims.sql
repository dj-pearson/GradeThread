-- US-867: Condition-backed buyer trust guarantee + mediation/claim intake.
--
-- Productizes the "GradeThread-Verified" trust promise. A buyer who bought a
-- graded item and believes it is "materially not as graded" (vs. the certified,
-- structured disclosure in grade_reports.defects_found — see disclosure.ts) can
-- file a claim referencing the public certificate_id. An admin then reviews the
-- claim against the certificate's defects/disclosure and records a decision +
-- audit trail.
--
-- SCOPE (v1): policy page + claim intake + admin review ONLY. There are NO
-- automated payouts — resolution is manual (status flips + a free-text
-- resolution note). The money/refund side stays off-platform for v1.
--
-- PII / TENANT SAFETY (US-268): buyers are typically NOT GradeThread account
-- holders, so claims are filed through an UNAUTHENTICATED edge endpoint
-- (service-role, RLS-bypassing) which resolves the owning tenant
-- (seller_user_id) and the internal grade_report_id server-side from the public
-- certificate_id — the request body never dictates ownership. claimant_email is
-- buyer PII; we therefore enable RLS and add NO permissive policies. Only the
-- service-role edge (public intake + admin review) ever reads/writes this table;
-- a bare authenticated PostgREST client sees nothing. This mirrors the
-- locked-down approach used for the referral leaderboard opt-in (00195).

-- Claim lifecycle. submitted → under_review → approved | rejected.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guarantee_claim_status') THEN
    CREATE TYPE public.guarantee_claim_status AS ENUM (
      'submitted',
      'under_review',
      'approved',
      'rejected'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.guarantee_claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The PUBLIC certificate the claim is about (grade_reports.certificate_id is
  -- unique). We keep BOTH the public id (how the buyer references the item) and
  -- the internal grade_report_id (the FK the admin review joins through).
  certificate_id    uuid NOT NULL,
  grade_report_id   uuid NOT NULL REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  -- Owning tenant (the seller who submitted the grade) — resolved server-side
  -- from the certificate, never from the request. Scopes the claim to a tenant.
  seller_user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Buyer contact (PII — admin-only via the service-role edge).
  claimant_email    text NOT NULL,
  claimant_name     text,
  -- Where the buyer purchased the item + their order/transaction reference.
  marketplace       text,
  order_reference   text,
  -- The buyer's description of how the item is "materially not as graded".
  reason            text NOT NULL,
  -- Optional structured issues the buyer is claiming, mirroring the defect shape
  -- ({ defect, severity, location }) so a reviewer can line them up against the
  -- certified defects_found.
  claimed_issues    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Buyer-provided evidence links (e.g. their own photos hosted elsewhere). v1
  -- captures URLs only — no upload pipeline, keeping the intake PII-light.
  evidence_urls     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            public.guarantee_claim_status NOT NULL DEFAULT 'submitted',
  -- Admin decision (manual; no automated payout in v1).
  resolution        text,
  reviewed_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guarantee_claims_certificate_id
  ON public.guarantee_claims (certificate_id);
CREATE INDEX IF NOT EXISTS idx_guarantee_claims_grade_report_id
  ON public.guarantee_claims (grade_report_id);
CREATE INDEX IF NOT EXISTS idx_guarantee_claims_seller_user_id
  ON public.guarantee_claims (seller_user_id);
CREATE INDEX IF NOT EXISTS idx_guarantee_claims_status
  ON public.guarantee_claims (status);
CREATE INDEX IF NOT EXISTS idx_guarantee_claims_created_at
  ON public.guarantee_claims (created_at DESC);

COMMENT ON TABLE public.guarantee_claims IS
  'US-867 buyer trust-guarantee claims. A buyer files a claim against a public '
  'certificate when an item is materially not as graded; admins review it against '
  'the certified disclosure. v1 = intake + manual review only (no auto payouts).';
COMMENT ON COLUMN public.guarantee_claims.seller_user_id IS
  'Owning tenant, resolved server-side from the certificate (never the request).';
COMMENT ON COLUMN public.guarantee_claims.claimant_email IS
  'Buyer PII. RLS denies all client access; only the service-role edge reads it.';

-- updated_at auto-managed by the shared trigger (00001).
DROP TRIGGER IF EXISTS set_guarantee_claims_updated_at ON public.guarantee_claims;
CREATE TRIGGER set_guarantee_claims_updated_at
  BEFORE UPDATE ON public.guarantee_claims
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS ON with NO permissive policies: the table holds buyer PII and is reached
-- ONLY through the service-role edge (public intake + admin review). A bare
-- anon/authenticated PostgREST client therefore sees and writes nothing.
ALTER TABLE public.guarantee_claims ENABLE ROW LEVEL SECURITY;
