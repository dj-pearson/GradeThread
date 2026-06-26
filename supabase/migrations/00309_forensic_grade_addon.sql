-- 00309_forensic_grade_addon.sql
--
-- US-1296: Forensic Grade — a paid add-on that enables the US-1035 defect-zoom
-- re-analysis path. The zoom pass crops + upscales small/uncertain defects from
-- the RETAINED ORIGINAL (US-339) and re-analyzes them at high resolution for a
-- more precise size/severity read. It is now OFF by default (the pipeline used to
-- run it on every grade, eating the extra vision-call cost) and only runs when
-- the seller purchased the Forensic add-on — monetizing accuracy instead of
-- absorbing the cost.
--
-- submissions.forensic_addon  — the seller opted into + paid for Forensic on this
--   submission (gated server-side to Premium/Express tiers + the feature flag +
--   original-image retention; see routes/grade.ts).
-- grade_reports.forensic_grade — whether the Forensic zoom re-analysis actually
--   ran for this report. The per-defect "which defects were zoom-refined" detail
--   lives in per_image_analysis (DetectedIssue.zoom_refined) + the
--   detailed_notes.forensic_summary line.
--
-- Idempotent (US-1108): ADD COLUMN IF NOT EXISTS + self-record footer.

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS forensic_addon boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.submissions.forensic_addon IS
  'US-1296: seller purchased the Forensic Grade add-on (paid defect-zoom '
  're-analysis). Gated to Premium/Express tiers + the forensic_grade feature '
  'flag + original-image retention. Drives the US-1035 zoom pass in the pipeline.';

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS forensic_grade boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.grade_reports.forensic_grade IS
  'US-1296: true when the Forensic defect-zoom re-analysis ran for this report. '
  'Which defects were zoom-refined is recorded per-issue in per_image_analysis '
  '(zoom_refined) and summarized in detailed_notes.forensic_summary.';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00309')
ON CONFLICT (version) DO NOTHING;
