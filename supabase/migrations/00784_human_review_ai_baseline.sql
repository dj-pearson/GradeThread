-- US-3323: keep the AI's own factor scores on every human review, so "AI vs
-- human" compares two different numbers.
--
-- applyGradeAdjustment (services/edge-functions/src/lib/grade-adjustment.ts)
-- writes the reviewer's correction over grade_reports.overall_score and the
-- five factor columns. Every accuracy reader then compared the report's CURRENT
-- score (by then the human's) with the human's score and read zero error on
-- every corrected grade. human_reviews.original_score has always kept the
-- pre-review overall. Nothing kept the pre-review FACTORS, so for an adjusted
-- grade they are gone. These five columns keep them from now on.
--
-- review_action names the review path that wrote the row. A send-back ("the
-- photos cannot support a grade") inserted adjusted_score NULL, which every
-- reader counted as "approved as-is", i.e. as the AI being right.
--
-- NULL on every row written before this migration, and readers treat NULL as
-- unknown. Nothing is backfilled: for an adjusted legacy grade the AI factors
-- no longer exist anywhere to backfill from.
--
-- human_reviews is readable by admins and reviewers only (00001 policies), so
-- the new columns inherit that and reach no seller or buyer surface.

ALTER TABLE public.human_reviews
  ADD COLUMN IF NOT EXISTS original_fabric_condition     numeric(3,1),
  ADD COLUMN IF NOT EXISTS original_structural_integrity numeric(3,1),
  ADD COLUMN IF NOT EXISTS original_cosmetic_appearance  numeric(3,1),
  ADD COLUMN IF NOT EXISTS original_functional_elements  numeric(3,1),
  ADD COLUMN IF NOT EXISTS original_odor_cleanliness     numeric(3,1),
  ADD COLUMN IF NOT EXISTS review_action                 text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'human_reviews_review_action_chk'
      AND conrelid = 'public.human_reviews'::regclass
  ) THEN
    ALTER TABLE public.human_reviews
      ADD CONSTRAINT human_reviews_review_action_chk
      CHECK (review_action IS NULL
             OR review_action IN ('approve', 'adjust', 'send_back', 'dispute'));
  END IF;
END $$;

COMMENT ON COLUMN public.human_reviews.original_fabric_condition IS
  'US-3323: the report''s fabric_condition_score as this review found it, before acting. '
  'On a grade''s earliest review this is the AI''s own score.';
COMMENT ON COLUMN public.human_reviews.review_action IS
  'US-3323: approve | adjust | send_back | dispute. NULL on rows before 00784. '
  'A send_back is not a grading verdict and is excluded from accuracy.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00784') on conflict do nothing;
