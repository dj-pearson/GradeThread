-- Server-side forensic / manipulation pass on retained originals (US-341).
--
-- A second, pixel/byte-level line of manipulation evidence that complements the
-- US-336 vision authenticity signal. It runs ONLY when an uncompressed original
-- (US-339, submission_images.original_storage_path) is available — forensic
-- signals are unreliable on the client-recompressed grading copies, so a
-- compressed-only submission is skipped cleanly and this column stays NULL.
--
--   forensic_analysis  The structured FusedTamperAssessment: the forensic
--                      per-image structural scores, the overall tamper
--                      likelihood, and the fusion with the vision signal that
--                      adjusted confidence / review routing. Internal anti-fraud
--                      data — NEVER exposed on the public certificate view
--                      (public_grade_reports omits it, same as
--                      image_authenticity.tells / confidence_score).

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS forensic_analysis jsonb;

COMMENT ON COLUMN public.grade_reports.forensic_analysis IS
  'Server-side forensic manipulation pass fused with the vision signal (US-341). '
  'Present only when an uncompressed original was retained (US-339); NULL for '
  'compressed-only submissions. Internal anti-fraud data — never public.';
