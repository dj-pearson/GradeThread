-- US-385: handle per-grade refunds (and chargebacks).
--
-- A one-time per-grade Checkout (submissions.payment_status='paid_stripe') that
-- gets refunded previously hit handleChargeRefunded's "no DB change" branch, so
-- the grade + public certificate stayed live after the money was returned. We
-- now mark the submission refunded, flag it for review, and withhold its public
-- certificate. This column records WHEN the refund landed (audit + admin
-- reconciliation); the existing flagged/flag_reason columns carry the review
-- signal, and the grade row itself is retained for that review.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

COMMENT ON COLUMN public.submissions.refunded_at IS
  'US-385: set when a per-grade charge.refunded (or dispute) is processed. '
  'Non-null => the grade was paid then refunded; the submission is flagged for '
  'review and its grade_reports.certificate_id is cleared to withhold the '
  'public certificate.';

CREATE INDEX IF NOT EXISTS idx_submissions_refunded_at
  ON public.submissions(refunded_at)
  WHERE refunded_at IS NOT NULL;
