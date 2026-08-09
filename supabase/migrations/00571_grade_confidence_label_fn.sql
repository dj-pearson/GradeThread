-- US-2303 AC2: the confidence buckets stop being copied into every revision of
-- the public certificate view.
--
-- ── THE STORY NAMES THE WRONG VIEW, AND THE WRONG NUMBER OF THEM ────────────
--
-- US-2303 says "four SQL view copies (00082, 00118, 00138, 00194)". A previous
-- pass corrected the count — they are not four copies but successive
-- CREATE OR REPLACE revisions of ONE view, public.public_grade_reports — and
-- named 00356 as the live one. THAT IS ALSO WRONG, and it is the dangerous kind
-- of wrong: three later revisions exist (00530 rubric factors, 00532 video
-- grading, 00534 live capture), so replacing 00356's body would have SILENTLY
-- REVERTED rubric_key, factor_scores, video_capture_verified and
-- video_live_capture_verified off the public certificate. CREATE OR REPLACE
-- would not have complained — it only refuses to DROP or reorder columns, and
-- those four are at the end.
--
-- There are SIXTEEN revisions in the corpus. Only the last is live. This file
-- is generated from 00534's own text with one expression substituted, so the
-- column list cannot drift from what is actually deployed.
--
-- ── WHY A FUNCTION AND NOT JUST ANOTHER CAREFUL COPY ────────────────────────
--
-- The boundaries (0.9 / 0.75 / 0.6) are the same decision the edge makes with a
-- tunable threshold, and the whole point of US-2303 is that lowering it in the
-- admin UI must not leave other surfaces deciding at the old number. A view
-- cannot read the env, but it CAN stop re-deriving the boundaries every time
-- someone adds a column — which is how a seventeenth revision would fork them.
--
-- IMMUTABLE, not STABLE: the output depends only on the argument, so Postgres
-- may inline it and index over it. STABLE would silently cost every certificate
-- read. Marked STRICT so a NULL confidence returns NULL rather than falling
-- through to 'reviewed' — a grade with no confidence recorded is not the same
-- as one that scored badly, and the old CASE got that wrong (NULL >= 0.9 is
-- NULL, so it fell to ELSE and reported 'reviewed'). That is a behaviour
-- change, and it is the correct direction: the client already treats a missing
-- label as "no badge", and claiming "reviewed" for a row we never scored is a
-- statement we cannot support on a public certificate.

CREATE OR REPLACE FUNCTION public.grade_confidence_label(score numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN score >= 0.9  THEN 'very_high'
    WHEN score >= 0.75 THEN 'high'
    WHEN score >= 0.6  THEN 'moderate'
    ELSE 'reviewed'
  END;
$$;

COMMENT ON FUNCTION public.grade_confidence_label(numeric) IS
  'US-2303 AC2: the ONE place the public confidence buckets are defined in SQL. '
  'public_grade_reports had re-derived them inline in all sixteen of its '
  'revisions. Mirrors the boundaries in src/lib/constants.ts and '
  'services/edge-functions/src/lib/ai-config.ts; the 0.75 boundary is the review '
  'threshold, which is tunable at the edge and fixed here — a view cannot read '
  'the setting, so the guard is that nothing re-forks these numbers.';

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
  public.grade_confidence_label(gr.confidence_score) AS confidence_label,
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
INSERT INTO public.applied_migrations (version) VALUES ('00571')
ON CONFLICT (version) DO NOTHING;
