-- Walk-around VIDEO grading (US-1762 epic; US-1764 / US-1765 / US-1766).
--
-- A seller records ONE short clip walking around the garment instead of staging
-- individual photos. The edge extracts a small set of frames server-side
-- (lib/video-frames.ts), writes them as ordinary `submission_images` rows, and
-- the existing per-image -> composite grading flow runs COMPLETELY UNCHANGED.
-- Nothing downstream of the frames knows the difference — which is the point.
--
-- This migration adds the four things the code path needs and nothing else:
--   1. submissions: the opt-in, the seller's guided slot marks, and the
--      server-side extraction record (what was sampled, what was dropped, why).
--   2. grade_reports.video_capture: the server-side provenance evaluation, plus
--      the public certificate's positive-only 'Video-Verified' badge column.
--   3. Cost control: a feature_flags kill-switch + ai_budgets rows for the
--      'video_grading' feature, and its entry in ai_feature_economics so the
--      admin AI-spend / profitability dashboards break it out on its own.
--   4. system_settings: the frame cap and the plan gate.
--
-- COST is the whole reason for (3). Frames ARE Vision calls: the pipeline issues
-- one per image and a video submission is billed as ONE grade, so an uncapped
-- frame count is a direct AI-cost multiplier. The frame cap is enforced in code
-- (clampFrameCount) AND bounded here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING throughout, and
-- the view is CREATE OR REPLACE with the full 00530 column set reproduced
-- verbatim and video_capture_verified APPENDED last (a replace may only add
-- trailing columns, never drop or reorder — else 42P16).

-- ── 1. Submissions: opt-in, guided marks, extraction record ───────────────────
ALTER TABLE public.submissions
  -- The seller chose to grade FROM the clip rather than from staged photos.
  -- Distinct from merely ATTACHING a video (00441), which is supplementary.
  ADD COLUMN IF NOT EXISTS video_grading_opt_in boolean NOT NULL DEFAULT false,
  -- Set true only once frames were actually extracted and stored. The grading
  -- pipeline reads THIS (never the opt-in) to decide whether to meter the grade
  -- under the 'video_grading' feature and to evaluate the provenance badge.
  ADD COLUMN IF NOT EXISTS video_graded boolean NOT NULL DEFAULT false,
  -- Seller-tapped "showing the front now" timestamps from the guided capture UI
  -- { front: 1.2, back: 4.8, label: 9.0, detail: 13.5 }. Optional and never
  -- trusted: parseVideoSlotMarks drops unknown slots and out-of-range times, so
  -- a forged blob can only make the sampling worse, never unsafe.
  ADD COLUMN IF NOT EXISTS video_slot_marks jsonb,
  -- Server-side extraction record { ok, frames[], dropped[], extracted, reason,
  -- max_frames, duration_seconds }. Ops/debug detail; never public.
  ADD COLUMN IF NOT EXISTS video_frames jsonb;

COMMENT ON COLUMN public.submissions.video_grading_opt_in IS
  'US-1762: the seller chose to GRADE FROM the walk-around clip (frames are '
  'extracted server-side and become submission_images) rather than staging '
  'photos. Distinct from video_storage_path (00441), which only ATTACHES a clip.';

COMMENT ON COLUMN public.submissions.video_graded IS
  'US-1762: frames were actually extracted from the clip and stored as '
  'submission_images. The grading pipeline reads THIS (not the opt-in) to meter '
  'under feature=video_grading and to evaluate the Video-Verified badge.';

COMMENT ON COLUMN public.submissions.video_slot_marks IS
  'US-1766: seller-tapped guided-capture timestamps per slot '
  '{front,back,label,detail,...} in seconds. Optional; re-validated + bounded '
  'server-side by parseVideoSlotMarks. Absent marks fall back to even sampling.';

COMMENT ON COLUMN public.submissions.video_frames IS
  'US-1764: server-side frame-extraction record { ok, frames[], dropped[], '
  'extracted, reason, max_frames, duration_seconds }. Operational detail for '
  'debugging a needs_photos fallback; never surfaced publicly.';

-- ── 2. Per-grade video provenance + the public badge ─────────────────────────
ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS video_capture jsonb;

COMMENT ON COLUMN public.grade_reports.video_capture IS
  'US-1762: server-side Video Capture evaluation { badge, video_graded, '
  'frames_used, duration_seconds, reasons[], checked_at }. badge '
  '''video_verified'' earned the certificate badge; NULL/none = no badge. '
  'Positive-only — never lowers a grade. NULL on every photo submission.';

-- CREATE OR REPLACE VIEW permits APPENDING columns only — the full current
-- column set from 00530 is reproduced verbatim and video_capture_verified is
-- appended last.
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
  END AS factor_scores,
  -- US-1762: appended last. TRUE only when the grade was produced from frames
  -- this server extracted from ONE continuous walk-around clip, with no
  -- suspected manipulation and no cross-account frame reuse. Positive-only —
  -- FALSE means "no badge", never "something is wrong". The raw frame metrics
  -- and the reasons a clip fell short stay server-side, exactly like the
  -- live_capture / verified_360 downgrade reasons above.
  (gr.video_capture ->> 'badge' = 'video_verified') AS video_capture_verified
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
  'US-348 + mandatory-review + US-1654 + US-1997 + US-1762: public-safe '
  'projection of FINALIZED certified grade_reports for anonymous certificate '
  'viewers. Excludes preliminary (review_status=pending) grades, '
  'anti-fraud/internal signals, AND (US-1654) any grade whose submission is '
  'moderation-withheld — status pending_review, or flagged and not '
  'moderation_status=approved — matching isCertificateWithheld so the view can '
  'never leak a cert the edge 404s. (US-1997) rubric_key + factor_scores carry '
  'NON-CLOTHING per-factor scores; factor_scores is rebuilt keeping only '
  'number-valued entries and collapses to NULL when empty, so the client falls '
  'back to the typed clothing columns. (US-1762) video_capture_verified is the '
  'positive-only Video-Verified capture badge.';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- ── 3. Cost control: kill-switch, budgets, feature economics ─────────────────
-- The kill-switch flag. resolveFlagKey('video_grading') is 1:1, so an
-- ai_budgets row with action='kill' flips exactly this. Fail-open (a missing
-- row reads as enabled), so this exists for admin visibility + the guardrail.
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'video_grading',
  true,
  'US-1762: grade a garment from a short walk-around clip (server-side frame '
  'extraction -> the normal per-image grading flow). Off = the video capture '
  'mode is hidden and /grade/submit rejects video_grading with a clear message.'
)
ON CONFLICT (key) DO NOTHING;

-- Two budgets, because the two actions answer different questions. The DAILY one
-- THROTTLES: a bad day is a signal, not a reason to take the feature away
-- mid-afternoon. The MONTHLY one KILLS: a month's spend past the ceiling is the
-- unit economics being wrong, and the only safe response is to stop.
INSERT INTO public.ai_budgets (feature, period, limit_usd, action, enabled)
VALUES
  ('video_grading', 'day',   25.00, 'throttle', true),
  ('video_grading', 'month', 400.00, 'kill',    true)
ON CONFLICT (feature, period) DO NOTHING;

-- Break video_grading out in the admin AI-spend / profitability dashboards.
-- Both `value` and `default_value` are patched so a "reset to default" doesn't
-- silently drop the feature back out of the dashboard. jsonb_set with
-- create_if_missing=true is a no-op-safe upsert of the one key.
UPDATE public.system_settings
SET
  value = jsonb_set(
    value,
    '{video_grading}',
    jsonb_build_object(
      'label', 'Video grading',
      'action_unit', 'submission',
      'revenue_basis', 'per_action',
      'revenue_per_action_usd', 2.99,
      'subscription_ref_usd', 0,
      'current_model', 'claude-sonnet-4-6',
      'recommended_model', 'claude-sonnet-4-6',
      'quality_note', 'Same vision work as a photo grade, but over frames the '
        'server chose — so the SAME per-image model applies and the only lever '
        'is the FRAME COUNT (video_grading_max_frames). Each extra frame is a '
        'full Vision call against one grade''s revenue; the sharpness/exposure '
        'selection and near-duplicate drop in video-frames.ts exist to keep that '
        'count honest rather than to improve the picture.',
      'fallback_cost_per_action_usd', 0.05
    ),
    true
  ),
  default_value = CASE
    WHEN default_value IS NULL THEN default_value
    ELSE jsonb_set(
      default_value,
      '{video_grading}',
      jsonb_build_object(
        'label', 'Video grading',
        'action_unit', 'submission',
        'revenue_basis', 'per_action',
        'revenue_per_action_usd', 2.99,
        'subscription_ref_usd', 0,
        'current_model', 'claude-sonnet-4-6',
        'recommended_model', 'claude-sonnet-4-6',
        'quality_note', 'Same vision work as a photo grade, but over frames the '
          'server chose — the only cost lever is the frame count.',
        'fallback_cost_per_action_usd', 0.05
      ),
      true
    )
  END
WHERE key = 'ai_feature_economics'
  AND jsonb_typeof(value) = 'object'
  AND NOT (value ? 'video_grading');

-- ── 4. Operator settings: frame cap + plan gate ─────────────────────────────
-- value_type must be one of number|bool|string|json (00208 check constraint).
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'video_grading_max_frames',
  '6'::jsonb,
  'number',
  '6'::jsonb,
  'grading',
  'US-1765: how many frames one walk-around clip may be graded from. Each frame '
  'is a Claude Vision call billed against a SINGLE grade, so this is the direct '
  'cost multiplier for video grading. Clamped in code to 4..8 (clampFrameCount) '
  '— 4 is the required front/back/label/detail coverage floor.'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'video_grading_plans',
  '["starter","pro","business"]'::jsonb,
  'json',
  '["starter","pro","business"]'::jsonb,
  'grading',
  'US-1765: effective FlipDesk plans allowed to grade from a video. Video costs '
  'several Vision calls per grade, so it is a paid-plan capability; free-plan '
  'sellers get the photo path (and an upgrade prompt), never a silent downgrade.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00532')
ON CONFLICT (version) DO NOTHING;
