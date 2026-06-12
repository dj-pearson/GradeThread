-- US-479: admin reject-and-regrade must actually re-run the grading pipeline and
-- supersede the prior report.
--
-- Before this story the admin "re-trigger grading" action set status='processing'
-- via a direct browser write and NOTHING re-ran the pipeline, so the submission
-- hung in 'processing' forever. The fix re-invokes processSubmission server-side,
-- which INSERTs a fresh grade_report. A submission can therefore now own more than
-- one grade_report over its lifetime (the original + one per regrade).
--
-- superseded_at marks the historical report(s) so every "current report" read
-- resolves to exactly one ACTIVE row (superseded_at IS NULL). The regrade endpoint
-- also nulls the superseded report's certificate_id, so its public certificate
-- stops verifying. This is non-destructive: disputes, human_reviews, and
-- grade_outcomes that reference the old report (FKs) are preserved as history.

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

-- The active report for a submission is the one with superseded_at IS NULL.
-- A partial index keeps the common "current report for this submission" lookup
-- fast and cheap (the superseded rows are rare tail history).
CREATE INDEX IF NOT EXISTS idx_grade_reports_active
  ON public.grade_reports(submission_id)
  WHERE superseded_at IS NULL;
