-- US-773: sweep abandoned-checkout submissions + idempotent server-side pay kick.
--
-- Two gaps this closes:
--
--   1. A per-grade submission whose user opened Checkout and closed the tab sits
--      at status='pending', payment_status='unpaid' forever, polluting their list
--      and never resolving. The stuck-submissions reaper only swept 'processing'.
--      We add an 'expired' terminal status so the reaper can retire those (no
--      charge attempted), and the UI can show "payment not completed — resubmit".
--
--   2. The grading pipeline kick is NOT idempotent (re-running processSubmission
--      double-bills Claude — see US-569). The Stripe webhook AND the client
--      ?pay_retry=1 redirect can both fire it for the same paid submission. A
--      single-claim guard (grading_started_at) ensures exactly one grade run no
--      matter how many times the pipeline is kicked.

-- New terminal status for an abandoned (never-paid) submission. Distinct from
-- 'failed' (a real grading error, which refunds) and 'needs_photos' (abstained).
-- No grade_report, no charge — the seller simply resubmits.
ALTER TYPE public.submission_status ADD VALUE IF NOT EXISTS 'expired';

-- Set the first time a grade run claims this submission. The pipeline's atomic
-- claim (UPDATE … WHERE grading_started_at IS NULL) means only the first kick
-- proceeds; concurrent/duplicate kicks (webhook + client retry) find it set and
-- no-op, so Claude is billed once. A future re-grade (US-569) must clear it.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS grading_started_at timestamptz;

COMMENT ON COLUMN public.submissions.grading_started_at IS
  'US-773: idempotency claim for the grading pipeline. Set once by the first '
  'processSubmission() kick (atomic UPDATE … WHERE grading_started_at IS NULL); '
  'duplicate kicks no-op. Distinct from status=processing (set per-run).';

-- The abandoned-checkout sweep scans pending + unpaid rows by age; the
-- stranded-paid recovery scans pending + non-unpaid rows by age. A partial index
-- on the pending hot set keeps both scans cheap.
CREATE INDEX IF NOT EXISTS idx_submissions_pending_updated
  ON public.submissions(updated_at)
  WHERE status = 'pending';
