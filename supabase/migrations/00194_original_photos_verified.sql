-- "Original photos verified" anti-fraud badge — positive phash signal (US-861).
--
-- We already compute a perceptual hash per grading photo and detect cross-account
-- photo REUSE for moderation (services/edge-functions/src/lib/photo-reuse.ts):
-- a photo matching a DIFFERENT account is the stock/stolen-listing tell and
-- flags the submission. This migration exposes the POSITIVE case as a
-- buyer-trust signal: when a graded submission's photos were actually compared
-- and none matched another account, the certificate earns an "Original photos
-- verified" badge.
--
-- DESIGN — this is a POSITIVE signal only, mirroring Verified Capture (US-340):
--   * Positive-only: a missing/uncertain result (the scan couldn't run — no
--     hashable images or a DB hiccup) NEVER renders a negative public claim. It
--     simply doesn't earn the badge.
--   * Cross-account reuse does NOT land here as a negative — it FLAGS the
--     submission in the pipeline, and a flagged certificate stays WITHHELD from
--     the public surface until a human clears it (US-484). So the badge only
--     ever appears on cleared, un-reused photos.
--   * The public certificate view exposes ONLY the pass/fail boolean below — no
--     hashes, distances, or match details ever leak.

-- 1. Per-grade result of the original-photos evaluation. jsonb so the structured
--    server-side detail (how many images were compared, when) is retained for
--    admin review; the public certificate view exposes only the boolean below.
ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS original_photos jsonb;

COMMENT ON COLUMN public.grade_reports.original_photos IS
  'US-861: server-side "original photos verified" signal { verified, checked, '
  'checked_at }, derived from the photo-reuse scan (US-337). verified=true means '
  'the photos were compared against the corpus and none matched a DIFFERENT '
  'account (stock/stolen tell); same-account relists still count as original. '
  'NULL for grades produced before the check. The public view exposes only the '
  'verified boolean (no hashes/match details).';

-- 2. Append ONLY the pass/fail boolean to the public certificate view. CREATE OR
--    REPLACE VIEW permits APPENDING columns only (same prior columns, in the
--    same order/type); original_photos_verified is appended after the US-601
--    authenticity columns (the prior last columns). Grants survive.
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
  COALESCE((gr.verified_capture ->> 'verified')::boolean, false)
    AS verified_capture_passed,
  (gr.authenticity_assessment IS NOT NULL) AS authenticity_addon_included,
  CASE
    WHEN gr.authenticity_assessment IS NULL THEN NULL
    WHEN (gr.authenticity_assessment ->> 'authenticity_confidence')::numeric >= 0.85 THEN 'high'
    WHEN (gr.authenticity_assessment ->> 'authenticity_confidence')::numeric >= 0.6  THEN 'moderate'
    ELSE 'low'
  END AS authenticity_confidence_label,
  (gr.authenticity_assessment ->> 'counterfeit_risk') AS authenticity_counterfeit_risk,
  (gr.authenticity_assessment ->> 'summary') AS authenticity_summary,
  (gr.authenticity_assessment ->> 'limitations') AS authenticity_limitations,
  -- US-861: appended last. True only when the photos were compared and none
  -- matched a different account. Positive-only — false simply means no badge.
  COALESCE((gr.original_photos ->> 'verified')::boolean, false)
    AS original_photos_verified
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL;
