-- Staged prompt rollout / canary % (US-896).
--
-- Today a grading prompt is all-or-nothing: activatePromptVersion (US-330/00050)
-- flips is_active and 100% of live traffic switches to it. This adds a CANARY
-- lane so an eval-passed candidate can take a configurable PERCENTAGE of live
-- grading traffic, bucketed by a stable per-submission hash, while the current
-- active prompt serves the rest. The operator watches canary-vs-active accuracy/
-- confidence/dispute signals (GET /api/admin/grading/prompts/:id/canary) before
-- promoting to 100% (the existing activate path) or rolling back.
--
-- This is the LIVE-percentage complement to shadow grading (00115): shadow runs
-- a candidate OFFLINE on a sample and never affects a customer's grade; a canary
-- IS the customer's grade for its traffic slice. Promotion still goes through the
-- eval gate — a canary can only be set on an eval_passed candidate.

ALTER TABLE public.ai_prompt_versions
  -- Percentage of live grading traffic [0–100] routed to this version as a
  -- canary for its (stage, garment_scope) slot. 0 = no canary traffic.
  ADD COLUMN IF NOT EXISTS rollout_percentage integer NOT NULL DEFAULT 0
    CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
  -- Marks this row as the active canary challenger for its slot. Independent of
  -- is_active: a canary is NOT the champion (is_active stays false). At most one
  -- canary per (stage, scope) — enforced by the partial unique index below.
  ADD COLUMN IF NOT EXISTS is_canary boolean NOT NULL DEFAULT false,
  -- When the current canary slice was opened (for "early dispute since rollout"
  -- windowing); cleared on rollback / promotion.
  ADD COLUMN IF NOT EXISTS rollout_started_at timestamptz;

COMMENT ON COLUMN public.ai_prompt_versions.rollout_percentage IS
  'US-896: percentage [0–100] of live grading traffic routed to this version as '
  'a canary, bucketed by a stable per-submission hash. 0 = off.';
COMMENT ON COLUMN public.ai_prompt_versions.is_canary IS
  'US-896: this row is the active canary challenger for its (stage, scope) slot. '
  'Not the champion (is_active stays false). Promotion still requires the eval gate.';

-- Only ONE canary per (stage, scope) slot, mirroring the active-slot unique
-- index from 00050. COALESCE so the NULL (global) scope collapses to one slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prompt_versions_canary_stage_scope
  ON public.ai_prompt_versions(stage, COALESCE(garment_scope, ''))
  WHERE is_canary = true;
