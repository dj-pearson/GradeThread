-- Persist the AI's low-confidence "needs human review" signal (US-073).
--
-- ai-grading.ts computes needs_human_review (confidence < 0.75) but the grading
-- pipeline never wrote it — the admin review queue re-derived it from a
-- hardcoded 0.75 threshold in the frontend. Storing it on the report gives a
-- durable hook and keeps the trigger threshold in one place (the AI lib).

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS needs_human_review boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.grade_reports.needs_human_review IS
  'Set by the grading pipeline when AI confidence is below the human-review '
  'threshold. Drives the admin review queue.';

-- Backfill existing rows so the queue is unchanged for historical grades.
UPDATE public.grade_reports
  SET needs_human_review = true
  WHERE confidence_score < 0.75 AND needs_human_review = false;

CREATE INDEX IF NOT EXISTS idx_grade_reports_needs_human_review
  ON public.grade_reports(needs_human_review)
  WHERE needs_human_review = true;
