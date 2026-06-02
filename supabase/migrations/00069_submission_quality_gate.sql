-- Pre-grade image-quality gate + active abstention (US-332).
--
-- When the submitted photos are too blurry/dark/incomplete to grade reliably,
-- the pipeline abstains instead of emitting a low-confidence grade: it sets the
-- submission to 'needs_photos' and records actionable photo requests in
-- quality_feedback. Abstention is distinct from 'failed' (a real error) and
-- creates no grade_report, so no paid grade credit is consumed.

-- New terminal-ish status for an abstained submission. Distinct from 'failed'
-- (pipeline error) and 'completed' (graded). The seller fixes the flagged
-- photos and resubmits.
ALTER TYPE public.submission_status ADD VALUE IF NOT EXISTS 'needs_photos';

-- Actionable feedback when the quality gate abstains:
--   { summary, photo_requests: string[], issues: [...], assessed_at }
-- Cleared (set NULL) when a later run produces a grade.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS quality_feedback jsonb;

COMMENT ON COLUMN public.submissions.quality_feedback IS
  'US-332: when status=needs_photos, the image-quality gate''s summary + '
  'actionable photo_requests + per-image issues. NULL once a grade is produced.';
