-- US-3330: name the one flaw that keeps a grade from the next level.
--
-- grade_reports.limiting_flaw holds { defect, location, next_tier }: the model's
-- own description of the flaw (already public in defects_found), where it is,
-- and the tier its removal would reach. Written at grade time by the pipeline;
-- cleared by applyGradeAdjustment, because after a human correction it would
-- describe a grade that no longer exists. NULL when no single flaw is limiting.
--
-- Never a number. The per-defect penalty is deliberately unpublished
-- (defect-weighting.ts, US-2107); the view below projects only the three
-- string keys, so even a stray numeric field could not reach an anonymous
-- viewer. public_grade_reports is 00787 verbatim plus that one column,
-- appended last.

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS limiting_flaw jsonb;

COMMENT ON COLUMN public.grade_reports.limiting_flaw IS
  'US-3330: { defect, location, next_tier } for the single flaw keeping this grade '
  'from a higher tier, or NULL. Words only; cleared on human adjustment.';

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
  -- AND the clip was recorded live in the in-app recorder.
  COALESCE(
    (gr.video_capture ->> 'badge' = 'video_verified')
      AND (gr.video_capture ->> 'live_captured')::boolean,
    false
  ) AS video_live_capture_verified,
  -- US-3329: appended last, after 00571's columns.
  COALESCE(s.seller_statements, '{}'::text[]) AS seller_statements,
  -- False only when there were analyses and EVERY one listed odor_cleanliness
  -- as unassessable. No analyses (older rows) reads as visible, so nothing is
  -- claimed about a grade this cannot see into.
  NOT COALESCE((
    SELECT bool_and(
      COALESCE(elem -> 'unassessable_factors', '[]'::jsonb) ? 'odor_cleanliness'
    )
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(gr.per_image_analysis) = 'array'
           THEN gr.per_image_analysis ELSE '[]'::jsonb END
    ) AS elem
  ), false) AS cleanliness_visible,
  -- US-3330: appended last. Rebuilt from the three string keys only, so
  -- whatever the column holds, the public view can never carry a number
  -- (the per-defect penalty is deliberately unpublished).
  CASE
    WHEN jsonb_typeof(gr.limiting_flaw) = 'object'
     AND gr.limiting_flaw ->> 'next_tier' IS NOT NULL
    THEN jsonb_build_object(
      'defect', gr.limiting_flaw ->> 'defect',
      'location', COALESCE(gr.limiting_flaw ->> 'location', ''),
      'next_tier', gr.limiting_flaw ->> 'next_tier'
    )
    ELSE NULL
  END AS limiting_flaw
FROM public.grade_reports gr
LEFT JOIN public.submissions s ON s.id = gr.submission_id
WHERE gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified')
  AND s.status IS DISTINCT FROM 'pending_review'
  AND (s.flagged IS NOT TRUE OR s.moderation_status = 'approved');

COMMENT ON VIEW public.public_grade_reports IS
  'US-348 + mandatory-review + US-1654 + US-1997 + US-1762 + US-1766 + US-3329 + US-3330: '
  'public-safe projection of FINALIZED certified grade_reports for anonymous '
  'certificate viewers. Excludes preliminary grades, anti-fraud/internal '
  'signals and moderation-withheld submissions (matching isCertificateWithheld). '
  '(US-3329) seller_statements is the seller''s own claim; cleanliness_visible is '
  'false when no analyzed photo could judge cleanliness. (US-3330) limiting_flaw '
  'names the flaw keeping the grade from the next tier, strings only.';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00788') on conflict do nothing;
