-- Provenance for auto-promoted golden eval cases (US-329).
--
-- Closes the self-improvement loop: when a human reviewer corrects a grade (or a
-- dispute is resolved by adjusting it), that corrected garment is promoted into
-- a CANDIDATE eval case (is_active=false) so the benchmark grows from real
-- mistakes — especially intentional-design misreads. These columns record where
-- a case came from and dedup so one grade report yields at most one candidate.

ALTER TABLE public.grading_eval_cases
  ADD COLUMN IF NOT EXISTS source_grade_report_id uuid
    REFERENCES public.grade_reports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN public.grading_eval_cases.source_grade_report_id IS
  'The grade report this case was auto-promoted from (US-329). NULL for '
  'hand-authored cases.';
COMMENT ON COLUMN public.grading_eval_cases.source IS
  'How the case was created: human_review | dispute | manual (NULL = manual).';

-- Dedup: at most one candidate per source grade report.
CREATE UNIQUE INDEX IF NOT EXISTS idx_grading_eval_cases_source_report
  ON public.grading_eval_cases(source_grade_report_id)
  WHERE source_grade_report_id IS NOT NULL;
