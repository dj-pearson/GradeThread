-- US-759 / US-770: buyer-facing certified condition write-up.
--
-- `ai_summary` is a 2–4 sentence blurb. `buyer_writeup` is the longer,
-- buyer-facing condition report (what the item is, materials/construction,
-- the condition narrative, and a plain-language "why this grade") composed by
-- the grading engine. It is a CERTIFIED claim: from certificate integrity v2
-- (US-770) it is sealed into the content hash, so it can't be altered without
-- the public /cert/:id/verify check failing.

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS buyer_writeup text;

COMMENT ON COLUMN public.grade_reports.buyer_writeup IS
  'US-759: longer buyer-facing certified condition report (vs the short '
  'ai_summary). Sealed into the certificate content hash from integrity v2 '
  '(US-770).';

-- Expose it on the public certificate view. CREATE OR REPLACE VIEW only permits
-- APPENDING columns (same names/order/types as before, additions at the end),
-- so buyer_writeup is added as the final column. Grants survive the replace.
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
  -- US-759: appended last (CREATE OR REPLACE VIEW requires additions at the end).
  gr.buyer_writeup
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL;
