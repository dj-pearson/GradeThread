-- 00319_guarantee_remedies.sql
--
-- US-1280: the Grade Accuracy Guarantee remedy ledger. When an admin APPROVES a
-- guarantee claim (US-867 guarantee_claims) AND the claimed defect sits in a
-- zone the certificate documented (coverage-gated, US-1279), GradeThread makes
-- it right by REFUNDING THE GRADING FEE the seller paid + granting a free
-- re-grade credit — never by refunding item value or shipping (that stays with
-- the marketplace/seller).
--
-- This table is the idempotency guard + audit ledger: exactly one remedy per
-- claim (claim_id UNIQUE). The remedy code INSERTs ... ON CONFLICT (claim_id) DO
-- NOTHING to claim ownership before moving any money, so a double-approve / retry
-- can never issue a second refund or re-grant credits.
--
-- TENANT / PII SAFETY (US-268): the remedy is owed to the SELLER (seller_user_id,
-- resolved from the verified claim — never the request). Like its parent
-- guarantee_claims (00197), this is reached ONLY through the service-role admin
-- edge, so RLS is enabled with NO policies (deny-all to anon/authenticated). The
-- owner column is seller_user_id (not a bare user_id) to match the parent.
--
-- Idempotent (US-1108): IF NOT EXISTS everywhere + self-record footer.

CREATE TABLE IF NOT EXISTS public.guarantee_remedies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One remedy per claim — the idempotency key (ON CONFLICT DO NOTHING).
  claim_id            uuid NOT NULL UNIQUE
                        REFERENCES public.guarantee_claims(id) ON DELETE CASCADE,
  grade_report_id     uuid NOT NULL REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  -- The submission whose grading fee is refunded.
  submission_id       uuid NOT NULL,
  -- The seller who paid the grading fee and receives the refund + re-grade credit.
  seller_user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- How the grading fee was refunded: 'stripe' (card charge reversed),
  -- 'credit' (credit-back of the credits spent), or 'none' (included/unpaid —
  -- nothing was charged, so only the free re-grade credit is granted).
  fee_refund_method   text NOT NULL DEFAULT 'none'
                        CHECK (fee_refund_method IN ('stripe', 'credit', 'none')),
  -- Grading fee refunded to a card (cents). Capped at the actual charge by Stripe
  -- (a payment_intent refund reverses exactly that charge). Item value/shipping
  -- are NEVER part of this charge, so they can't be refunded here.
  fee_refund_cents    integer NOT NULL DEFAULT 0 CHECK (fee_refund_cents >= 0),
  -- Grading fee refunded as credits (when the grade was paid with credits).
  fee_refund_credits  integer NOT NULL DEFAULT 0 CHECK (fee_refund_credits >= 0),
  -- The free re-grade credit granted on top of the fee refund (normally 1).
  regrade_credits     integer NOT NULL DEFAULT 0 CHECK (regrade_credits >= 0),
  -- Stripe refund id when fee_refund_method = 'stripe'.
  stripe_refund_id    text,
  -- The documented (covered) zones the approved claim fell within — the proof
  -- the remedy was in-scope. Audit only.
  documented_zones    jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guarantee_remedies_seller_user_id
  ON public.guarantee_remedies (seller_user_id);
CREATE INDEX IF NOT EXISTS idx_guarantee_remedies_grade_report_id
  ON public.guarantee_remedies (grade_report_id);
CREATE INDEX IF NOT EXISTS idx_guarantee_remedies_created_at
  ON public.guarantee_remedies (created_at DESC);

COMMENT ON TABLE public.guarantee_remedies IS
  'US-1280 Grade Accuracy Guarantee remedy ledger. One row per approved, '
  'in-scope guarantee claim (claim_id UNIQUE = idempotency guard). Records the '
  'grading-fee refund (Stripe or credit-back) + free re-grade credit. Never '
  'refunds item value/shipping. Service-role only (RLS on, no policies).';

-- RLS ON with NO permissive policies: a money ledger touched ONLY by the
-- service-role admin edge. A bare anon/authenticated PostgREST client sees and
-- writes nothing (same lockdown as guarantee_claims, 00197).
ALTER TABLE public.guarantee_remedies ENABLE ROW LEVEL SECURITY;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00319') ON CONFLICT DO NOTHING;
