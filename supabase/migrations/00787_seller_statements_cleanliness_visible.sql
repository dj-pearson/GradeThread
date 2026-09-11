-- US-3329 part 2: the seller's smoke-free / pet-free statement, and an honest
-- "not visible in these photos" for the Cleanliness factor.
--
-- 1. submissions.seller_statements: optional, from a fixed list, captured at
--    submit. It is the SELLER'S claim. It is shown on the certificate as
--    "Seller states", never entered into a grading prompt, and never moves a
--    score (guarded in cleanliness-statements_test.ts).
--
-- 2. public_grade_reports gains two columns, APPENDED LAST (CREATE OR REPLACE
--    VIEW can only add columns at the end; the rest is 00571 verbatim):
--      seller_statements   - the list above, for the certificate.
--      cleanliness_visible - false when EVERY analyzed photo marked the factor
--                            odor_cleanliness unassessable. The composite then
--                            wrote a neutral placeholder, and the certificate
--                            should say so rather than print it as a finding.
--                            per_image_analysis itself stays off the view.
--    The edge certificate path sends the same two fields
--    (routes/content-public.ts), per vault/20-domain/public-certificate-read-paths.md.

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS seller_statements text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'submissions_seller_statements_chk'
      AND conrelid = 'public.submissions'::regclass
  ) THEN
    ALTER TABLE public.submissions
      ADD CONSTRAINT submissions_seller_statements_chk
      CHECK (seller_statements <@ ARRAY['smoke_free', 'pet_free']::text[]);
  END IF;
END $$;

COMMENT ON COLUMN public.submissions.seller_statements IS
  'US-3329: the seller''s own statements (smoke_free, pet_free). Shown on the '
  'certificate as the seller''s claim; never graded and never in a prompt.';

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
  ), false) AS cleanliness_visible
FROM public.grade_reports gr
LEFT JOIN public.submissions s ON s.id = gr.submission_id
WHERE gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified')
  AND s.status IS DISTINCT FROM 'pending_review'
  AND (s.flagged IS NOT TRUE OR s.moderation_status = 'approved');

COMMENT ON VIEW public.public_grade_reports IS
  'US-348 + mandatory-review + US-1654 + US-1997 + US-1762 + US-1766 + US-3329: '
  'public-safe projection of FINALIZED certified grade_reports for anonymous '
  'certificate viewers. Excludes preliminary grades, anti-fraud/internal '
  'signals and moderation-withheld submissions (matching isCertificateWithheld). '
  '(US-3329) seller_statements is the seller''s own claim, shown as such; '
  'cleanliness_visible is false when no analyzed photo could judge cleanliness.';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00787') on conflict do nothing;
