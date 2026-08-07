-- Live-capture provenance for a walk-around clip (US-1766).
--
-- 00532 shipped the Video-Verified badge: every graded view came out of ONE
-- continuous clip the server decoded itself. This adds the one thing that badge
-- could not say — where the CLIP came from.
--
-- A clip recorded live in GradeThread's in-app recorder never existed as a file
-- before the submission, so it cannot be footage of a different garment, or of
-- this garment months ago. A clip picked from the camera roll can be either, and
-- still earns the standard badge because the one-take claim holds regardless.
-- So this is a MODIFIER on the earned badge, not a second gate: positive-only,
-- and never true without video_capture_verified.
--
-- The marker is client-asserted (same as live PHOTO capture, 00314), which is
-- why it may only strengthen a badge the server-side checks already earned.
--
--   1. submissions.video_capture_source — the normalized marker.
--   2. public_grade_reports.video_live_capture_verified — the public boolean.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and CREATE OR REPLACE VIEW with the full
-- 00532 column set reproduced verbatim and the new column APPENDED last (a
-- replace may only add trailing columns, never drop or reorder — else 42P16).

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS video_capture_source text;

COMMENT ON COLUMN public.submissions.video_capture_source IS
  'US-1766: how the walk-around clip entered the app — ''in_app_recorder'' '
  '(recorded live in GradeThread''s own recorder) or ''library'' (an existing '
  'file). Client-asserted, normalized by parseVideoCaptureSource (anything else '
  'becomes NULL). NULL on every photo submission. Positive-only: it can only '
  'strengthen an already-earned Video-Verified badge, never gate one.';

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
  gr.coverage AS coverage,
  gr.certified_content_updated_at,
  gr.rubric_key,
  CASE
    WHEN jsonb_typeof(gr.factor_scores) = 'object' THEN NULLIF((
      SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      FROM jsonb_each(gr.factor_scores) AS e
      WHERE jsonb_typeof(e.value) = 'number'
    ), '{}'::jsonb)
    ELSE NULL
  END AS factor_scores,
  (gr.video_capture ->> 'badge' = 'video_verified') AS video_capture_verified,
  -- US-1766: appended last. TRUE only when the Video-Verified badge was earned
  -- AND the clip was recorded live in the in-app recorder. The AND is redundant
  -- with the evaluator (live_captured is written only alongside the badge) and
  -- kept anyway, because this view is the surface an anonymous viewer reads and
  -- it should not depend on a writer staying disciplined. COALESCE keeps the
  -- NULL case (no clip, older row) reading as "no badge", never as unknown.
  COALESCE(
    (gr.video_capture ->> 'badge' = 'video_verified')
      AND (gr.video_capture ->> 'live_captured')::boolean,
    false
  ) AS video_live_capture_verified
FROM public.grade_reports gr
LEFT JOIN public.submissions s ON s.id = gr.submission_id
WHERE gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified')
  AND s.status IS DISTINCT FROM 'pending_review'
  AND (s.flagged IS NOT TRUE OR s.moderation_status = 'approved');

COMMENT ON VIEW public.public_grade_reports IS
  'US-348 + mandatory-review + US-1654 + US-1997 + US-1762 + US-1766: '
  'public-safe projection of FINALIZED certified grade_reports for anonymous '
  'certificate viewers. Excludes preliminary (review_status=pending) grades, '
  'anti-fraud/internal signals, AND (US-1654) any grade whose submission is '
  'moderation-withheld — status pending_review, or flagged and not '
  'moderation_status=approved — matching isCertificateWithheld so the view can '
  'never leak a cert the edge 404s. (US-1997) rubric_key + factor_scores carry '
  'NON-CLOTHING per-factor scores; factor_scores is rebuilt keeping only '
  'number-valued entries and collapses to NULL when empty, so the client falls '
  'back to the typed clothing columns. (US-1762) video_capture_verified is the '
  'positive-only Video-Verified capture badge; (US-1766) '
  'video_live_capture_verified is its stronger reading — the clip was recorded '
  'live in the in-app recorder.';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00534')
ON CONFLICT (version) DO NOTHING;
