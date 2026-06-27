-- Verified 360 — photogrammetric / LiDAR capture badge (US-1281).
--
-- The premium follow-on to the 2D zone-coverage engine (US-1276). On a capable
-- device (LiDAR / multi-angle photogrammetry) a seller may OPT IN to a guided
-- "Verified 360" capture that proves TRUE GEOMETRIC coverage of the garment. The
-- on-device session reports a small metrics blob (angles, surface coverage, depth
-- used); the server-side evaluator (verified-360.ts) is AUTHORITATIVE and
-- re-checks the thresholds at grading time before awarding the "360-Verified"
-- badge — mirroring Live Capture's server-verified device-attestation (US-1283).
--
-- DESIGN — never required, never a penalty:
--   * Not opting in (or an unsupported device) grades exactly as before; the 2D
--     zone coverage (US-1276) stands as the fallback.
--   * A passing capture earns the badge + a small confidence boost and lets the
--     pipeline upgrade the stored coverage to geometric-complete (widest
--     coverage-gated guarantee scope, US-1279). Any shortfall earns no badge and
--     leaves the grade untouched; the reason is kept server-side for admin review.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the view is CREATE OR REPLACE with the
-- full 00315 column set reproduced verbatim and verified_360_badge APPENDED last
-- (a replace may only add trailing columns, never drop/reorder — else 42P16).

-- ── 1. Per-submission opt-in + device-reported capture metrics ────────────────
ALTER TABLE public.submissions
  -- The seller chose the Verified 360 capture path (only offered on capable
  -- devices). The badge is only AWARDED if the server-side metrics also clear the
  -- thresholds at grading time (see grade_reports.verified_360). Never lowers a grade.
  ADD COLUMN IF NOT EXISTS verified_360_opt_in boolean NOT NULL DEFAULT false,
  -- Device-reported guided-capture metrics { angles, geometric_coverage,
  -- depth_available, capture_complete, device_model }. Re-verified server-side.
  ADD COLUMN IF NOT EXISTS capture_360 jsonb;

COMMENT ON COLUMN public.submissions.verified_360_opt_in IS
  'US-1281: the seller opted into the premium Verified 360 capture path '
  '(photogrammetric / LiDAR true-geometric coverage). The 360-Verified badge is '
  'only AWARDED if the server-side capture metrics also clear the thresholds at '
  'grading time (see grade_reports.verified_360). Never required; never lowers a grade.';

COMMENT ON COLUMN public.submissions.capture_360 IS
  'US-1281: device-reported guided 360-capture metrics { angles, '
  'geometric_coverage (0..1), depth_available, capture_complete, device_model }. '
  'Re-verified server-side by verified-360.ts — a forged metric cannot mint the badge alone.';

-- ── 2. Per-grade Verified 360 evaluation result ───────────────────────────────
ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS verified_360 jsonb;

COMMENT ON COLUMN public.grade_reports.verified_360 IS
  'US-1281: server-side Verified 360 evaluation { verified, badge, '
  'geometric_coverage_pct, depth_used, angles, reasons[], checked_at }. badge '
  '''verified_360'' earned the certificate badge + a confidence boost + '
  'geometric-complete coverage; NULL/none = no badge. NULL when the seller did '
  'not opt in / the device was not capable.';

-- ── 3. Expose ONLY the earned badge tier on the public certificate view ───────
-- CREATE OR REPLACE VIEW permits APPENDING columns only — the full current column
-- set from 00315 is reproduced verbatim and verified_360_badge is appended last.
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
  -- US-1281: appended last. True only when the submission earned the premium
  -- '360-Verified' badge (a passing photogrammetric/LiDAR true-geometric
  -- capture). Positive-only — false = no badge; raw metrics stay server-side.
  (gr.verified_360 ->> 'badge' = 'verified_360') AS verified_360_badge
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified');

COMMENT ON VIEW public.public_grade_reports IS
  'US-348 + mandatory-review: public-safe projection of FINALIZED certified '
  'grade_reports for anonymous certificate viewers. Excludes preliminary '
  '(review_status=pending) grades and anti-fraud/internal signals. US-1287 adds '
  'defect_annotations; US-1283 adds live_capture_verified; US-1282 adds '
  'garment_id; US-1281 adds verified_360_badge (the premium 360-Verified badge).';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00316')
ON CONFLICT (version) DO NOTHING;
