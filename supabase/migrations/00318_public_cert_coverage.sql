-- 00318_public_cert_coverage.sql
--
-- US-1278: expose the persisted photo-coverage record (US-1276, stored on
-- grade_reports.coverage by 00308) to anonymous certificate viewers, so the
-- public certificate can render a "Coverage: NN% documented" badge plus a
-- garment-silhouette heatmap shading documented vs not-documented zones.
--
-- The coverage blob is buyer-safe by construction: it only describes which
-- standard inspection zones the seller's photos actually documented
-- ({garment_category, applicable_zones[], covered_zones[], missing_zones[],
-- coverage_pct, coverage_source}). There is no anti-fraud / internal signal in
-- it — quite the opposite, surfacing it is the whole point of the coverage-gated
-- guarantee (US-1279/1280): the buyer must see exactly what the grade does and
-- does NOT cover. Reports graded before 00308 carry NULL coverage; the cert
-- widget degrades gracefully and simply hides when the column is null.
--
-- CREATE OR REPLACE VIEW permits APPENDING columns only — the full current
-- column set from 00316 is reproduced verbatim and `coverage` is appended last.
--
-- Idempotent (US-1108): CREATE OR REPLACE VIEW + self-record footer.

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
  COALESCE((gr.original_photos ->> 'verified')::boolean, false)
    AS original_photos_verified,
  gr.certificate_number,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'image_type', elem ->> 'image_type',
        'annotations', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'issue', iss ->> 'issue',
              'severity', iss ->> 'severity',
              'location', COALESCE(iss ->> 'location', ''),
              'bbox', iss -> 'bbox'
            )
          )
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(elem -> 'detected_issues') = 'array'
                 THEN elem -> 'detected_issues' ELSE '[]'::jsonb END
          ) AS iss
          WHERE COALESCE((iss ->> 'is_intentional')::boolean, false) = false
            AND jsonb_typeof(iss -> 'bbox') = 'array'
        ), '[]'::jsonb)
      )
    )
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(gr.per_image_analysis) = 'array'
           THEN gr.per_image_analysis ELSE '[]'::jsonb END
    ) AS elem
  ), '[]'::jsonb) AS defect_annotations,
  (gr.live_capture ->> 'badge' = 'live_verified') AS live_capture_verified,
  gr.garment_id,
  (gr.verified_360 ->> 'badge' = 'verified_360') AS verified_360_badge,
  -- US-1278: appended last. The persisted 2D zone-coverage record (US-1276):
  -- {garment_category, applicable_zones[], covered_zones[], missing_zones[],
  -- coverage_pct, coverage_source}. NULL for reports graded before 00308 — the
  -- cert widget hides itself in that case. Buyer-safe: describes only what the
  -- photos documented, the foundation of the coverage-gated guarantee.
  gr.coverage AS coverage
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified');

COMMENT ON VIEW public.public_grade_reports IS
  'US-348 + mandatory-review: public-safe projection of FINALIZED certified '
  'grade_reports for anonymous certificate viewers. Excludes preliminary '
  '(review_status=pending) grades and anti-fraud/internal signals. US-1287 adds '
  'defect_annotations; US-1283 adds live_capture_verified; US-1282 adds '
  'garment_id; US-1281 adds verified_360_badge; US-1278 adds coverage (the '
  '2D inspection-zone coverage record powering the certificate coverage badge '
  '+ silhouette heatmap and the coverage-gated guarantee).';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00318') ON CONFLICT DO NOTHING;
