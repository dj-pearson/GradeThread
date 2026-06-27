-- Garment Passport — re-grade lineage + condition-over-time curve (US-1282).
--
-- The "Carfax for clothing" needs grade history to ACCUMULATE on a single
-- garment identity across re-grades (and across owners). Until now every grade
-- created a fresh single-hop passport (00256 garments + a 'graded' event), so a
-- re-grade of the SAME physical garment produced an unrelated second passport
-- and no condition-over-time curve was possible.
--
-- This migration adds the two pieces that close that gap:
--   1. submissions.regrade_of_garment_id — a NEW grade may declare it is a
--      re-grade of an existing (owned) garment. The grading pipeline then links
--      the new grade_report to that garment and APPENDS a 'graded' event to its
--      ledger, instead of minting a new passport. Tenant-scoped at write time
--      (the pipeline verifies created_by ownership before it trusts the id).
--   2. public_grade_reports.garment_id — so the public passport can read a
--      garment's full grade history (overall + the five per-factor condition
--      scores) from the PII-FREE view ONLY (US-1282 AC4), never the base table.
--      garment_id is a passport identity (already public via the slug), not PII.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the view is CREATE OR REPLACE with the
-- full 00314 column set reproduced verbatim and garment_id APPENDED last (a
-- replace may only add trailing columns, never drop/reorder — else 42P16).

-- ── 1. Re-grade linkage on submissions ───────────────────────────────────────
ALTER TABLE public.submissions
  -- The existing garment this submission re-grades (NULL for a first grade). The
  -- pipeline only honors it after verifying the garment's created_by matches the
  -- submitting workspace owner (US-268) — a forged/foreign id is ignored.
  ADD COLUMN IF NOT EXISTS regrade_of_garment_id uuid
    REFERENCES public.garments(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.submissions.regrade_of_garment_id IS
  'US-1282: this submission is a re-grade of an existing Garment Passport. The '
  'grading pipeline links the new grade_report to this garment and appends a '
  'graded event (building the condition-over-time curve) instead of minting a '
  'new passport. Honored only after the pipeline verifies created_by ownership.';

-- Resolve "the re-grades of this garment" cheaply.
CREATE INDEX IF NOT EXISTS idx_submissions_regrade_of_garment
  ON public.submissions(regrade_of_garment_id)
  WHERE regrade_of_garment_id IS NOT NULL;

-- ── 2. Expose garment_id on the public certificate view ──────────────────────
-- CREATE OR REPLACE VIEW permits APPENDING columns only — the full current
-- column set from 00314 is reproduced verbatim and gr.garment_id is appended
-- last. Omitting any existing column raises 42P16 "cannot drop columns".
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
  -- US-1282: appended last. The passport identity this grade belongs to, so the
  -- public passport can assemble a garment's condition-over-time curve from this
  -- PII-free view alone. A passport id (already public via the slug), not PII.
  gr.garment_id
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified');

COMMENT ON VIEW public.public_grade_reports IS
  'US-348 + mandatory-review: public-safe projection of FINALIZED certified '
  'grade_reports for anonymous certificate viewers. Excludes preliminary '
  '(review_status=pending) grades and anti-fraud/internal signals. US-1287 adds '
  'defect_annotations; US-1283 adds live_capture_verified; US-1282 adds '
  'garment_id (Garment Passport condition-over-time curve).';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00315')
ON CONFLICT (version) DO NOTHING;
