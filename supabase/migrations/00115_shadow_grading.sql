-- Shadow / A-B grading of candidate prompts on live traffic (US-330).
--
-- A candidate composite prompt can be marked `is_shadow`. After a real
-- submission's LIVE grade is produced, the pipeline (fire-and-forget) re-runs
-- ONLY the composite stage with the shadow candidate prompt — reusing the
-- already-computed per-image analyses, so a shadow grade costs one extra
-- composite call, not a full re-grade. The shadow output is stored here,
-- NEVER on grade_reports, NEVER shown to the customer or used for the
-- certificate. Sampling rate + a daily cap bound the cost.
--
-- Promotion is unchanged: activation still requires eval_passed=true against
-- the golden set (grading-eval.ts activatePromptVersion). Shadow data is
-- advisory evidence only.

-- ════════════════════════════════════════════════════════════════════
-- 1. Shadow knobs on ai_prompt_versions
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.ai_prompt_versions
  -- Mark a candidate to run in shadow on live traffic. Independent of
  -- is_active: a shadow candidate is NOT live (is_active stays false) and
  -- never affects a customer grade.
  ADD COLUMN IF NOT EXISTS is_shadow boolean NOT NULL DEFAULT false,
  -- Fraction of eligible submissions to shadow-grade (0.0–1.0). 0 disables.
  ADD COLUMN IF NOT EXISTS shadow_sample_rate numeric(5,4) NOT NULL DEFAULT 0
    CHECK (shadow_sample_rate >= 0 AND shadow_sample_rate <= 1),
  -- Hard ceiling on shadow grades/day for this version (cost guardrail).
  ADD COLUMN IF NOT EXISTS shadow_daily_cap integer NOT NULL DEFAULT 200
    CHECK (shadow_daily_cap >= 0);

COMMENT ON COLUMN public.ai_prompt_versions.is_shadow IS
  'When true, this candidate composite prompt is run in SHADOW on a sample of '
  'live submissions (after the real grade). Advisory only — never live, never '
  'shown to the customer. Activation still requires the eval gate (US-330).';

-- ════════════════════════════════════════════════════════════════════
-- 2. Shadow results (compared against the live grade, per submission)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.grading_shadow_results (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenancy: the submission and its owner. user_id is stamped explicitly so
  -- the row is tenant-scoped (US-268) even though admin analytics read across
  -- tenants, mirroring grade_outcomes / accuracy tracking.
  submission_id             uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  user_id                   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The live grade this shadow result is compared against.
  grade_report_id           uuid REFERENCES public.grade_reports(id) ON DELETE SET NULL,
  -- The candidate prompt run in shadow.
  shadow_prompt_version_id  uuid REFERENCES public.ai_prompt_versions(id) ON DELETE SET NULL,
  shadow_prompt_version_name text NOT NULL,
  active_prompt_version_name text NOT NULL,
  model                     text NOT NULL,
  -- Live (active) grade.
  active_overall_score      numeric(3,1) NOT NULL,
  active_grade_tier         public.grade_tier NOT NULL,
  active_factor_scores      jsonb NOT NULL DEFAULT '{}',
  -- Shadow grade (NULL when the shadow composite call errored — `error` set).
  shadow_overall_score      numeric(3,1),
  shadow_grade_tier         public.grade_tier,
  shadow_factor_scores      jsonb,
  -- shadow_overall_score - active_overall_score (signed); NULL on error.
  score_delta               numeric(4,1),
  -- |score_delta| <= 0.5 (the agreement band); NULL on error.
  agreement                 boolean,
  -- Slice tags for divergence analysis, e.g. {distressed_denim, raw_hem}.
  tags                      text[] NOT NULL DEFAULT '{}',
  -- Set when the shadow composite call failed (kept for cost/visibility).
  error                     text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grading_shadow_results_version_created
  ON public.grading_shadow_results(shadow_prompt_version_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_grading_shadow_results_created_at
  ON public.grading_shadow_results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_grading_shadow_results_submission
  ON public.grading_shadow_results(submission_id);

-- ── RLS: admin-only reads; writes are service-role (the pipeline) only ──
-- The SPA never reads this; it's an admin analytics surface. Service-role
-- (edge) bypasses RLS to write. An admin SELECT policy keeps the table off the
-- rls-guard's deny-list while exposing nothing to ordinary users.
ALTER TABLE public.grading_shadow_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read shadow results"
  ON public.grading_shadow_results FOR SELECT
  USING (public.is_admin());
