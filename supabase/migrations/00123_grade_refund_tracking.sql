-- US-771: automated Stripe refunds for paid-but-ungraded per-grade submissions.
--
-- When a customer pays per-grade via Stripe and the submission then ends up
-- WITHOUT a grade (pipeline failure, or the image-quality gate abstaining),
-- refund_grade() returns 'no_refund_paid_stripe' — real money that can't be
-- reversed by minting credits. Previously the pipeline only console.error'd
-- "issue a Stripe refund manually". This adds the columns + queue needed to
-- issue the refund automatically and, on failure, surface it to an operator.

-- The PaymentIntent so an ungraded paid submission can be refunded without
-- hunting for the charge; stored by the per-grade checkout webhook (US-771).
-- The auto-refund id when it succeeds.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS stripe_refund_id text;

COMMENT ON COLUMN public.submissions.stripe_payment_intent_id IS
  'Stripe PaymentIntent for a paid_stripe (per-grade) submission, stored at '
  'webhook time so an ungraded paid submission can be auto-refunded (US-771).';
COMMENT ON COLUMN public.submissions.stripe_refund_id IS
  'Set when refund_grade''s paid_stripe path was auto-refunded via Stripe (US-771).';

-- Operator queue: per-grade refunds that could NOT be issued automatically
-- (a Stripe error, or a paid_stripe submission with no stored PaymentIntent).
-- The admin billing UI lists open rows so an operator can complete the refund.
CREATE TABLE IF NOT EXISTS public.pending_refunds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id     uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  payment_intent_id text,
  -- Why the refund is owed (e.g. 'pipeline_failed' / 'needs_photos').
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'resolved', 'canceled')),
  -- The Stripe/error message from the failed auto-refund attempt.
  last_error        text,
  -- Set once the refund is completed (auto-resolve or operator action).
  stripe_refund_id  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES public.users(id)
);

-- At most one OPEN row per submission — a repeated failed attempt updates the
-- existing row rather than piling up duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_refunds_open_submission
  ON public.pending_refunds(submission_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_refunds_status
  ON public.pending_refunds(status, created_at);

-- Admin-only resource. RLS on with NO client policies → deny-all for
-- anon/authenticated; the edge service writes/reads via the service-role key
-- (which bypasses RLS), and admin endpoints are themselves role-gated.
ALTER TABLE public.pending_refunds ENABLE ROW LEVEL SECURITY;
