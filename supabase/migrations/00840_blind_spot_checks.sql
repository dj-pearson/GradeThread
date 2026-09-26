-- US-3524: blind human spot checks on auto-approved grades.
--
-- Grades at confidence >= the auto-approve threshold go live with no human
-- ever looking, and every human review that does happen shows the reviewer
-- the AI's answer first. So calibration and agreement are measured only on
-- low-confidence grades, by reviewers anchored to the AI. A small random share
-- of auto-approved grades is now flagged for a BLIND check: the reviewer scores
-- the photos without seeing the AI's grade, and the result is recorded as a
-- human_reviews row with review_action 'spot_check'. It does not change the
-- published grade; a large disagreement is a signal for an admin to act on.
--
--   grade_reports.spot_check_requested_at  set when sampled (edge, pipeline)
--   grade_reports.spot_check_done_at       set when the blind score lands
--   human_reviews.review_action            gains 'spot_check'

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS spot_check_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS spot_check_done_at      timestamptz;

CREATE INDEX IF NOT EXISTS idx_grade_reports_spot_check_open
  ON public.grade_reports (spot_check_requested_at)
  WHERE spot_check_requested_at IS NOT NULL AND spot_check_done_at IS NULL;

ALTER TABLE public.human_reviews
  DROP CONSTRAINT IF EXISTS human_reviews_review_action_chk;
ALTER TABLE public.human_reviews
  ADD CONSTRAINT human_reviews_review_action_chk
  CHECK (review_action IS NULL
         OR review_action IN ('approve', 'adjust', 'send_back', 'dispute', 'spot_check'));

COMMENT ON COLUMN public.human_reviews.review_action IS
  'US-3323: approve | adjust | send_back | dispute. US-3524: spot_check = a blind '
  'score of an auto-approved grade; adjusted_score is the human''s blind overall and '
  'the published grade is unchanged. NULL on rows before 00784. A send_back is not a '
  'grading verdict and is excluded from accuracy.';

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00840') ON CONFLICT DO NOTHING;
