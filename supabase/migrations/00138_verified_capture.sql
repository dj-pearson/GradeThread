-- Verified Capture: opt-in provenance booster + badge (US-340).
--
-- Builds on the EXIF/original retention pipeline (US-339, migration 00137). A
-- seller can OPT IN to a "verified capture" path: photos taken with consistent,
-- recent, unedited provenance (in-app capture and/or original-with-EXIF upload).
-- When the server-side checks pass, the submission earns a "Verified Capture"
-- badge on its certificate and a small confidence BOOST.
--
-- DESIGN — this is a POSITIVE signal only:
--   * Verified capture is never required and missing EXIF is NEVER a penalty.
--     A submission that doesn't opt in (or whose provenance is absent) grades
--     exactly as before — it simply doesn't earn the badge or the boost.
--   * Anti-gaming is server-side: spoofed/edited EXIF (editor software tells,
--     future/old timestamps, mixed devices) and cross-account reused photos
--     (US-337) do NOT earn the badge. The opt-in flag alone grants nothing.

-- 1. Per-submission opt-in flag. Set at /submit from the seller's choice. Absence
--    / false means "did not request verified capture" — the common, unpenalized
--    case.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS verified_capture_opt_in boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.submissions.verified_capture_opt_in IS
  'US-340: the seller opted into the Verified Capture provenance path for this '
  'submission. The badge is only AWARDED if the server-side provenance checks '
  'also pass (see grade_reports.verified_capture). Opting in never lowers a grade.';

-- 2. Per-grade result of the verified-capture evaluation. jsonb so the structured
--    server-side detail (device, recency, reasons) is retained for admin review;
--    the public certificate view exposes only the pass/fail boolean below.
ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS verified_capture jsonb;

COMMENT ON COLUMN public.grade_reports.verified_capture IS
  'US-340: server-side Verified Capture evaluation { verified, reasons[], '
  'device, with_exif, total, max_age_days, checked_at }. NULL for grades '
  'produced before the check / when the seller did not opt in. The verified '
  'flag, when true, earned the certificate badge and a small confidence boost.';

-- 3. Expose ONLY the pass/fail boolean on the public certificate view (the raw
--    reasons/device stay server-side so they can't be used to reverse-engineer
--    the checks). CREATE OR REPLACE VIEW permits APPENDING columns only — same
--    names/order/types as before, additions at the end. verified_capture_passed
--    is appended after buyer_writeup (the prior last column). Grants survive.
CREATE OR REPLACE VIEW public.public_grade_reports AS
SELECT
  gr.id,
  gr.submission_id,
  gr.certificate_id,
  gr.created_at,
  gr.overall_score,
  gr.grade_tier,
  gr.fabric_condition_score,
  gr.structural_integrity_score,
  gr.cosmetic_appearance_score,
  gr.functional_elements_score,
  gr.odor_cleanliness_score,
  gr.ai_summary,
  gr.model_version,
  gr.human_reviewed,
  gr.defects_found,
  gr.detected_style_attributes,
  (gr.image_authenticity IS NOT NULL) AS authenticity_checked,
  COALESCE((gr.image_authenticity ->> 'manipulation_suspected')::boolean, false)
    AS authenticity_manipulation_suspected,
  COALESCE((gr.image_authenticity ->> 'screenshot_or_watermark_detected')::boolean, false)
    AS authenticity_screenshot_or_watermark_detected,
  CASE
    WHEN gr.confidence_score >= 0.9  THEN 'very_high'
    WHEN gr.confidence_score >= 0.75 THEN 'high'
    WHEN gr.confidence_score >= 0.6  THEN 'moderate'
    ELSE 'reviewed'
  END AS confidence_label,
  gr.buyer_writeup,
  -- US-340: appended last. True only when the provenance checks passed.
  COALESCE((gr.verified_capture ->> 'verified')::boolean, false)
    AS verified_capture_passed
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL;
