-- US-1997: expose grade_reports.rubric_key + factor_scores on the PUBLIC
-- certificate view. Migration 00231 added both columns and deferred this
-- exposure to "the activation phase"; the owner settled that on 2026-07-23
-- (ACTIVATE — non-clothing grading is on the roadmap), so this is that phase.
--
-- Why this is a live gap and not just scaffolding. There are TWO public read
-- paths for a certificate and only ONE of them was extended:
--   • the EDGE endpoint (content-public.ts CERT_REPORT_COLUMNS) — already lists
--     both columns.
--   • this VIEW — which is what the SPA actually reads. src/pages/certificate.tsx
--     and src/pages/embed-grade.tsx both do `.from("public_grade_reports")
--     .select("*")`, so they see exactly this SELECT list and nothing else.
-- certificate.tsx branches on `factor_scores && rubric_key` to render a
-- non-clothing factor breakdown. Because the view never projected either column,
-- that branch was unreachable REGARDLESS of what the pipeline writes — fixing
-- the writer alone would not have made it fire. Two independent gaps; only the
-- writer one was recorded.
--
-- Reproduces every column and predicate from 00356 verbatim and appends THREE:
-- the two US-1997 columns, plus `certified_content_updated_at` (US-2392), which
-- the parity guard shipped alongside this migration caught as the same defect in
-- the same view — see the comment at that column. The row set is unchanged.
-- Idempotent (CREATE OR REPLACE VIEW). No data change.
--
-- PRIVACY. Per-factor scores are already public here for clothing (the five
-- typed *_score columns), so the generic map is the same class of data, not a
-- new disclosure; rubric_key is a category slug written by the server. But
-- factor_scores is free-form jsonb, so the view does NOT pass it through raw:
-- it is rebuilt keeping only NUMBER-valued entries. That way the column cannot
-- become a leak channel if a future writer ever stashes a note, an id or a
-- nested object in it — a guard that holds without trusting the writer, which
-- is the point, since the writer does not exist yet.

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
  -- US-2392, folded in here because the parity guard this migration ships found
  -- it and it is the SAME defect in the SAME view. `certified_content_updated_at`
  -- is declared on PublicGradeReportRow and read by certificate.tsx:588, which
  -- publishes it as schema.org `dateModified`. The view never projected it, so
  -- the SPA certificate's dateModified has always been null — while the SSR cert
  -- (functions/cert/[id].ts) prints the real value, because THAT path reads the
  -- edge endpoint's CERT_REPORT_EXTRA_COLUMNS, which US-2392 did extend. Two
  -- public read paths disagreeing about the same field, which is precisely the
  -- split that hid the rubric columns below. Not a new disclosure: the edge has
  -- served this value publicly since 00522.
  gr.certified_content_updated_at,
  -- US-1997 — the two new columns.
  --
  -- rubric_key names which rubric produced factor_scores ('sports_cards',
  -- 'watches', 'shoes'). NULL on clothing and on every legacy row, which is the
  -- correct state, not a backlog item: clothing renders from the five typed
  -- columns above, and copying them into factor_scores as well would be
  -- redundant AND stale-prone (the human-review reseal and adjustment write
  -- paths update only the typed columns).
  gr.rubric_key,
  -- factor_scores is rebuilt, not passed through. Only NUMBER-valued entries
  -- survive, so a non-numeric value a future writer might add can never reach
  -- an anonymous viewer.
  --
  -- The empty result collapses to NULL rather than '{}'. That matters: the
  -- client guard is `factor_scores && rubric_key`, and `{}` is TRUTHY in JS, so
  -- an empty object would take the non-clothing branch and render a breakdown
  -- in which every factor resolves to 0. NULL keeps the typed-column fallback.
  CASE
    WHEN jsonb_typeof(gr.factor_scores) = 'object' THEN NULLIF((
      SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      FROM jsonb_each(gr.factor_scores) AS e
      WHERE jsonb_typeof(e.value) = 'number'
    ), '{}'::jsonb)
    ELSE NULL
  END AS factor_scores
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
  'US-348 + mandatory-review + US-1654 + US-1997: public-safe projection of '
  'FINALIZED certified grade_reports for anonymous certificate viewers. Excludes '
  'preliminary (review_status=pending) grades, anti-fraud/internal signals, AND '
  '(US-1654) any grade whose submission is moderation-withheld — status '
  'pending_review, or flagged and not moderation_status=approved — matching '
  'isCertificateWithheld so the view can never leak a cert the edge 404s. '
  '(US-1997) rubric_key + factor_scores carry NON-CLOTHING per-factor scores; '
  'factor_scores is rebuilt keeping only number-valued entries and collapses to '
  'NULL when empty, so the client falls back to the typed clothing columns.';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00530') ON CONFLICT DO NOTHING;
