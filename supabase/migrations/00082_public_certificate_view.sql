-- US-348: Stop public RLS exposing the full grade_reports row.
--
-- Until now anonymous certificate viewers could `select('*')` on any certified
-- grade_reports row via the broad "certificate_id IS NOT NULL" SELECT policy.
-- That leaked internal + anti-fraud signals to anyone holding a certificate_id:
--   image_authenticity.tells, per_image_analysis, detailed_notes,
--   confidence_score, content_signature/content_hash/integrity_version,
--   needs_human_review, intentional_misread, adjusted_* scores, prompt_version.
--
-- Fix: expose a column-restricted, SECURITY DEFINER-style view holding only the
-- public-safe certificate fields, and DROP the broad table policy so anon can no
-- longer read the base table at all. The certificate page reads the view.
--
-- The view is owned by the migration role (postgres), which is not subject to
-- the base table's RLS, so it can project the safe columns. `security_invoker`
-- is left OFF (the default) precisely so the view — not the caller's RLS — is
-- the gate. Anon/authenticated get SELECT on the view only.

-- 1. Remove the over-broad public policy on the base table. After this, an anon
--    `select('*')` on grade_reports matches no SELECT policy and returns zero
--    rows (RLS-enabled table, deny-by-default). Owners keep their own-row policy.
DROP POLICY IF EXISTS "Public can view grade reports with certificates" ON public.grade_reports;

-- 2. Column-restricted public certificate view. Only certified rows are visible.
--    Raw anti-fraud signals are NEVER projected; authenticity is reduced to the
--    two buyer-facing booleans and confidence to a coarse bucket (the precise
--    confidence_score is itself an anti-fraud signal and stays private).
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
  -- Public-safe authenticity summary. The raw `tells` array, per-image trace,
  -- confidences and flagged image types stay server-side only.
  (gr.image_authenticity IS NOT NULL) AS authenticity_checked,
  COALESCE((gr.image_authenticity ->> 'manipulation_suspected')::boolean, false)
    AS authenticity_manipulation_suspected,
  COALESCE((gr.image_authenticity ->> 'screenshot_or_watermark_detected')::boolean, false)
    AS authenticity_screenshot_or_watermark_detected,
  -- Coarse confidence bucket (mirrors the cert UI's confidenceLabel buckets).
  -- The raw 0–1 confidence_score is intentionally not exposed.
  CASE
    WHEN gr.confidence_score >= 0.9  THEN 'very_high'
    WHEN gr.confidence_score >= 0.75 THEN 'high'
    WHEN gr.confidence_score >= 0.6  THEN 'moderate'
    ELSE 'reviewed'
  END AS confidence_label
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL;

COMMENT ON VIEW public.public_grade_reports IS
  'US-348: public-safe projection of certified grade_reports for anonymous '
  'certificate viewers. Excludes anti-fraud/internal signals (tells, '
  'per_image_analysis, detailed_notes, raw confidence_score, content_signature). '
  'Query by certificate_id.';

-- 3. Grant read access to the public roles; revoke the implicit anon/auth read
--    of the base table is already handled by RLS deny-by-default above.
GRANT SELECT ON public.public_grade_reports TO anon, authenticated;
