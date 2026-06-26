-- Mandatory super-admin grade review (preliminary → finalized lifecycle).
--
-- Every AI grade is now PRELIMINARY when the pipeline finishes: the seller sees
-- an unofficial score immediately, but the certificate stays withheld and the
-- submission sits in `pending_review` until a super-admin agrees with the AI
-- grade (or adjusts it). Only on that human finalization does the grade become
-- official, the certificate go public, and the linked item go live.
--
-- This migration:
--   1. Records the review lifecycle on grade_reports (review_status + the
--      finalize audit columns + a tier-driven review SLA due time for the
--      priority-ordered operator queue).
--   2. Persists the requested grade-speed tier on the submission so the review
--      queue can prioritise express > premium > standard by their original SLA.
--   3. Adds the `pending_review` submission status.
--   4. Tightens the public certificate view so a preliminary (un-finalized)
--      grade is never publicly resolvable.
--   5. Backfills every PRE-EXISTING grade as already-finalized so live
--      certificates and the operator queue are unaffected by the rollout.

-- ── 1. grade_reports: review lifecycle ───────────────────────────────
ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'modified')),
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_due_at timestamptz;

COMMENT ON COLUMN public.grade_reports.review_status IS
  'Mandatory-review lifecycle: pending = AI grade awaiting human finalization '
  '(certificate withheld); approved = super-admin agreed with the AI grade as-is; '
  'modified = super-admin adjusted the scores before finalizing.';
COMMENT ON COLUMN public.grade_reports.finalized_at IS
  'When a human reviewer finalized this grade (made it official + public). NULL '
  'while still preliminary.';
COMMENT ON COLUMN public.grade_reports.reviewed_by IS
  'The reviewer who finalized (approved/modified) this grade.';
COMMENT ON COLUMN public.grade_reports.review_due_at IS
  'Target review-by time = report creation + the requested tier SLA (express 1h, '
  'premium 12h, standard 48h). Drives priority ordering in the operator queue.';

-- ── 2. submissions: requested grade-speed tier + new status ───────────
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS service_tier text NOT NULL DEFAULT 'standard'
    CHECK (service_tier IN ('standard', 'premium', 'express'));

COMMENT ON COLUMN public.submissions.service_tier IS
  'The grade-speed tier the seller paid for (standard/premium/express). Sets the '
  'review SLA + priority — NOT the quality grade_tier on grade_reports.';

-- ── 3. pending_review submission status ──────────────────────────────
-- ADD VALUE IF NOT EXISTS is idempotent and safe to run outside a using-
-- transaction (we never reference the new value later in this migration).
ALTER TYPE public.submission_status ADD VALUE IF NOT EXISTS 'pending_review';

-- New in-app notification types for the review lifecycle (seller-facing).
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'grading_preliminary';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'grading_finalized';

-- ── 4. Tighten the public certificate view ───────────────────────────
-- A grade is publicly resolvable ONLY once finalized (approved/modified). A
-- preliminary grade keeps its certificate_id but stays out of the public view.
-- CREATE OR REPLACE VIEW can only APPEND columns, never drop/reorder — so we
-- reproduce the FULL current column set verbatim (00194 columns + the
-- certificate_number added in 00307) and change ONLY the query body: the new
-- review_status filter that withholds preliminary grades. Omitting any existing
-- column here raises 42P16 "cannot drop columns from view".
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
  gr.certificate_number
FROM public.grade_reports gr
WHERE gr.certificate_id IS NOT NULL
  AND gr.review_status IN ('approved', 'modified');

COMMENT ON VIEW public.public_grade_reports IS
  'US-348 + mandatory-review: public-safe projection of FINALIZED certified '
  'grade_reports for anonymous certificate viewers. Excludes preliminary '
  '(review_status=pending) grades and anti-fraud/internal signals.';

GRANT SELECT ON public.public_grade_reports TO anon, authenticated;

-- ── 5. Backfill: every pre-existing grade is already final ───────────
-- The feature is net-new, so no historic grade should land in the new pending
-- queue or have its live certificate withheld. Mark them all finalized.
UPDATE public.grade_reports
  SET review_status = 'approved',
      finalized_at = COALESCE(finalized_at, created_at)
  WHERE review_status = 'pending';

-- ── Indexes for the priority operator queue ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_grade_reports_review_pending
  ON public.grade_reports(review_due_at)
  WHERE review_status = 'pending' AND superseded_at IS NULL;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00312')
ON CONFLICT (version) DO NOTHING;
