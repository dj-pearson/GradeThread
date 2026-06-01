-- Photo-authenticity signal + human-reviewed flag on grade reports
-- (US-336/US-338 + US-328).
--
-- 1. image_authenticity: the aggregated result of the grading vision pass's
--    tamper/screenshot check ({ manipulation_suspected, manipulation_confidence,
--    screenshot_or_watermark_detected, tells[], flagged_image_types[], summary }).
--    Nullable — historical grades predate the check. A suspected result already
--    forces needs_human_review=true in the pipeline; this column is the record
--    surfaced on the certificate + admin review.
--
-- 2. human_reviewed: true once a human reviewer has checked this grade
--    (approve-as-is or adjust). Public-safe boolean so the PUBLIC certificate can
--    show a "human-reviewed" badge without exposing the admin-only human_reviews
--    table. Set by the admin review flow (src/pages/admin/reviews.tsx).

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS image_authenticity jsonb,
  ADD COLUMN IF NOT EXISTS human_reviewed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.grade_reports.image_authenticity IS
  'Aggregated photo-authenticity assessment from the grading vision pass '
  '(US-336/US-338): manipulation_suspected, manipulation_confidence, '
  'screenshot_or_watermark_detected, tells, flagged_image_types, summary. '
  'A flagged result forces needs_human_review. NULL for historical grades.';
COMMENT ON COLUMN public.grade_reports.human_reviewed IS
  'True once a human reviewer has checked this grade (approve/adjust). Drives '
  'the public certificate "human-reviewed" badge without exposing human_reviews.';
