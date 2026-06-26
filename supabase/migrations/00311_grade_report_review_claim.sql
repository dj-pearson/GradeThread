-- Operator-queue claim locking for low-confidence human review (US-1293).
--
-- The human-review endpoints (US-775) let an operator adjust/approve a flagged
-- grade, but nothing stopped TWO operators from opening and working the same
-- item at once (duplicate effort / clobbered adjustments). These columns add a
-- soft, TTL-expiring claim lock the operator queue UI honors: claiming a report
-- stamps the claimer + time, and a claim older than the TTL is treated as stale
-- and reclaimable (so a walked-away operator never wedges the queue).

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS review_claimed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_claimed_at timestamptz;

COMMENT ON COLUMN public.grade_reports.review_claimed_by IS
  'Operator currently working this low-confidence grade in the review queue '
  '(US-1293). Cleared when the review resolves or the claim is released/expires.';
COMMENT ON COLUMN public.grade_reports.review_claimed_at IS
  'When the current review claim was taken; a claim older than the queue TTL is '
  'treated as stale and may be reclaimed by another operator.';

-- Partial index over the still-open, currently-claimed rows (the queue filters
-- to needs_human_review + not yet reviewed, so the live working set is small).
CREATE INDEX IF NOT EXISTS idx_grade_reports_review_claimed_by
  ON public.grade_reports(review_claimed_by)
  WHERE review_claimed_by IS NOT NULL;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00311')
ON CONFLICT (version) DO NOTHING;
