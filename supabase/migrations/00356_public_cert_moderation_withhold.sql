-- US-1654 / DB-P2: close the moderation-withhold bypass in public_grade_reports.
--
-- The public certificate + integrity-verify EDGE endpoints correctly 404 a
-- withheld grade (lib/certificate-visibility.ts isCertificateWithheld: the
-- submission is `pending_review`, OR flagged and not yet moderation-approved).
-- But the `public_grade_reports` VIEW gated only on gr.review_status — never on
-- the submission's moderation state — so a finalized-then-flagged certificate
-- stayed readable straight from PostgREST (anon has SELECT on the view), and the
-- SPA /cert/:id reads the view directly and still rendered the withheld grade's
-- score/tier/summary.
--
-- Fix: recreate the view (reproducing EVERY column from 00318 verbatim — the
-- SELECT list and per-column expressions are unchanged) and add a LEFT JOIN to
-- submissions plus a WHERE predicate that mirrors isCertificateWithheld exactly:
--   • exclude submission status = 'pending_review' (preliminary, not finalized)
--   • exclude flagged submissions unless moderation_status = 'approved'
-- A LEFT JOIN + IS DISTINCT FROM keeps the JS "null submission → not withheld"
-- semantics (grade_reports.submission_id is NOT NULL/FK, so no orphans in
-- practice — the LEFT JOIN is defensive parity, not a behaviour change).
--
-- Output columns are IDENTICAL to 00318 (only the row set narrows), so no client
-- projection changes. Idempotent (CREATE OR REPLACE VIEW). No data change.

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
  gr.coverage AS coverage
FROM public.grade_reports gr
-- US-1654: join the parent submission's moderation state (LEFT JOIN so a
-- (theoretical) orphan report is treated as NOT withheld, matching the edge's
-- null-submission handling).
LEFT JOIN public.submissions s ON s.id = gr.submission_id
WHERE gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified')
  -- US-1654: mirror isCertificateWithheld (lib/certificate-visibility.ts).
  AND s.status IS DISTINCT FROM 'pending_review'
  AND (s.flagged IS NOT TRUE OR s.moderation_status = 'approved');

COMMENT ON VIEW public.public_grade_reports IS
  'US-348 + mandatory-review + US-1654: public-safe projection of FINALIZED '
  'certified grade_reports for anonymous certificate viewers. Excludes '
  'preliminary (review_status=pending) grades, anti-fraud/internal signals, AND '
  '(US-1654) any grade whose submission is moderation-withheld — status '
  'pending_review, or flagged and not moderation_status=approved — matching '
  'isCertificateWithheld so the view can never leak a cert the edge 404s.';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00356') ON CONFLICT DO NOTHING;
