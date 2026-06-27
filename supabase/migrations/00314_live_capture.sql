-- Live Capture — fraud-proof grading mode (US-1283).
--
-- The flagship anti-fraud tier built ON TOP of Verified Capture (US-340). A
-- seller may opt into the "Live Capture" path: every photo must be captured LIVE
-- in the in-app camera (device-attested, no library upload), timestamped, so
-- condition proof cannot be Photoshopped or pulled from a stock listing. When the
-- submission is device-attested AND passes ALL the standard provenance checks AND
-- shows no manipulation, it earns the distinct, STRONGER "Live-Verified"
-- certificate badge (a larger confidence boost than standard Verified Capture).
--
-- DESIGN — mirrors Verified Capture; never a silent pass:
--   * Live Capture is never required; not opting in grades exactly as before.
--   * Any provenance / attestation / manipulation failure DOWNGRADES the badge
--     (to standard Verified Capture when provenance still independently passed,
--     else no badge) — the downgrade reason is recorded server-side for admin
--     review. The public certificate view exposes ONLY the earned badge tier.

-- 1. Per-submission opt-in flag. Set at /submit from the seller's choice. The
--    badge is only AWARDED if the server-side checks also pass at grading time
--    (see grade_reports.live_capture). Opting in never lowers a grade.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS live_capture_opt_in boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.submissions.live_capture_opt_in IS
  'US-1283: the seller opted into the fraud-proof Live Capture path (in-app '
  'camera only, device-attested). The Live-Verified badge is only AWARDED if the '
  'server-side provenance + attestation + manipulation checks also pass (see '
  'grade_reports.live_capture). Implies verified_capture_opt_in. Never lowers a grade.';

-- 2. Per-image capture provenance: how the photo entered the app. 'in_app_camera'
--    is the device-attested live capture; anything else (library/null) is a
--    library upload. Used to enforce Live Capture's "in-app only" rule at submit
--    and to gate the Live-Verified badge at grading time.
ALTER TABLE public.submission_images
  ADD COLUMN IF NOT EXISTS capture_source text;

COMMENT ON COLUMN public.submission_images.capture_source IS
  'US-1283: how this photo entered the app — ''in_app_camera'' = device-attested '
  'live capture; NULL/other = library upload. Every image of a Live Capture '
  'submission must be ''in_app_camera'' to earn the Live-Verified badge.';

-- 3. Per-grade result of the live-capture evaluation. jsonb so the structured
--    server-side detail (badge tier, device-attestation, downgrade reasons) is
--    retained for admin review; the public certificate view exposes only the
--    earned badge tier below.
ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS live_capture jsonb;

COMMENT ON COLUMN public.grade_reports.live_capture IS
  'US-1283: server-side Live Capture evaluation { badge, live_capture, '
  'device_attested, reasons[], checked_at }. badge ''live_verified'' earned the '
  'distinct certificate badge + a larger confidence boost; ''verified'' is a '
  'downgrade to standard Verified Capture; NULL/none = no badge. NULL for grades '
  'produced before the check / when the seller did not opt in.';

-- 4. Expose ONLY the earned badge tier on the public certificate view (the raw
--    downgrade reasons stay server-side, like Verified Capture). CREATE OR
--    REPLACE VIEW permits APPENDING columns only — the full current column set
--    from 00313 is reproduced verbatim and live_capture_verified is appended
--    last. Omitting any existing column raises 42P16 "cannot drop columns".
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
  -- US-1283: appended last. True only when the submission earned the strongest
  -- 'live_verified' badge (device-attested live capture, provenance verified, no
  -- manipulation). A downgrade to standard Verified Capture surfaces via the
  -- existing verified_capture_passed column. Positive-only — false = no badge.
  (gr.live_capture ->> 'badge' = 'live_verified') AS live_capture_verified
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified');

COMMENT ON VIEW public.public_grade_reports IS
  'US-348 + mandatory-review: public-safe projection of FINALIZED certified '
  'grade_reports for anonymous certificate viewers. Excludes preliminary '
  '(review_status=pending) grades and anti-fraud/internal signals. US-1287 adds '
  'defect_annotations; US-1283 adds live_capture_verified (the Live-Verified '
  'fraud-proof badge) — only the earned tier, never the downgrade reasons.';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00314')
ON CONFLICT (version) DO NOTHING;
