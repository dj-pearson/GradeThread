-- Authenticity / counterfeit-confidence signal — premium add-on (US-601).
--
-- A SEPARATE, opt-in premium signal that assesses whether the GARMENT itself
-- looks like an authentic example of its claimed brand (logo/print fidelity,
-- tag/label construction, stitching, hardware quality). It is deliberately
-- distinct from:
--   * the CONDITION grade (grade_reports.overall_score / factor scores), and
--   * the PHOTO-tamper / manipulation check (grade_reports.image_authenticity,
--     US-336/338 — "was the photo edited / is it a screenshot"), which is about
--     the IMAGE, not the garment.
--
-- DESIGN:
--   * Premium add-on: only offered on the paid Premium/Express grade tiers and
--     only when the seller opts in (submissions.authenticity_addon). The
--     existing per-tier charge covers it — no separate billing path.
--   * It is a CONFIDENCE signal, never a definitive authentication verdict; the
--     limitations are disclosed alongside it (grade_reports.authenticity_assessment).
--   * Gated behind the `authenticity_addon` feature flag so it can be switched
--     off without a redeploy (fail-open like the other flags).

-- 1. Per-submission opt-in flag. Set at /submit only when the seller opts in AND
--    the chosen tier is Premium/Express AND the feature flag is on. Absence /
--    false is the common case (no authenticity assessment requested).
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS authenticity_addon boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.submissions.authenticity_addon IS
  'US-601: the seller purchased the premium authenticity/counterfeit-confidence '
  'add-on for this submission (Premium/Express tiers only). When true, the '
  'grading pipeline runs a dedicated garment-authenticity vision pass and stores '
  'the result on grade_reports.authenticity_assessment. Distinct from the '
  'photo-tamper check (image_authenticity) and from the condition grade.';

-- 2. Per-grade authenticity assessment. jsonb so the structured server-side
--    detail (red flags, supporting signals, examined signals) is retained for
--    the owner/admin; the public certificate view exposes only the coarse,
--    buyer-safe fields below (no raw red-flag list — an over-strong public
--    counterfeit claim on a false positive would be harmful).
ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS authenticity_assessment jsonb;

COMMENT ON COLUMN public.grade_reports.authenticity_assessment IS
  'US-601: premium authenticity add-on result { assessed, authenticity_confidence '
  '(0-1), counterfeit_risk (low|elevated|high|indeterminate), brand_assessed, '
  'signals_examined[], red_flags[], supporting_signals[], summary, limitations, '
  'model }. NULL when the add-on was not purchased. A CONFIDENCE signal only — '
  'never a definitive authentication; limitations are always disclosed.';

-- 3. Seed the kill-switch flag (fail-open: a missing row reads as enabled, so
--    this is for admin visibility/toggling, not a hard requirement).
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'authenticity_addon',
  true,
  'US-601: premium authenticity/counterfeit-confidence add-on grading pass.'
)
ON CONFLICT (key) DO NOTHING;

-- 4. Expose ONLY buyer-safe authenticity fields on the public certificate view.
--    CREATE OR REPLACE VIEW permits APPENDING columns only (same prior columns,
--    in the same order/type); the new columns are appended after
--    verified_capture_passed (the prior last column). Grants survive.
--    We expose a coarse confidence label, the counterfeit-risk bucket, the
--    buyer-facing summary, and the limitations disclosure — but NOT the raw
--    red_flags/signals (those stay server-side, like image_authenticity.tells).
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
  -- US-601: premium authenticity add-on, appended last. NULL when not purchased.
  (gr.authenticity_assessment IS NOT NULL) AS authenticity_addon_included,
  CASE
    WHEN gr.authenticity_assessment IS NULL THEN NULL
    WHEN (gr.authenticity_assessment ->> 'authenticity_confidence')::numeric >= 0.85 THEN 'high'
    WHEN (gr.authenticity_assessment ->> 'authenticity_confidence')::numeric >= 0.6  THEN 'moderate'
    ELSE 'low'
  END AS authenticity_confidence_label,
  (gr.authenticity_assessment ->> 'counterfeit_risk') AS authenticity_counterfeit_risk,
  (gr.authenticity_assessment ->> 'summary') AS authenticity_summary,
  (gr.authenticity_assessment ->> 'limitations') AS authenticity_limitations
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL;
