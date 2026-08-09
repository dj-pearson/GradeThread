-- US-2443: make a PER-IMAGE prompt change comparable on live traffic.
--
-- Shadow grading has existed since 00115, but only at the composite stage: it
-- reuses the champion's per-image analyses and re-runs one text call. So every
-- per-image change the product has ever shipped — GRADING_TAG_OCR,
-- GRADING_CATEGORY_CRITERIA_V2, and now any block override on
-- garment_type_criteria or category_criteria — went out with a golden set and a
-- flag and no live-traffic evidence at all. A golden set is a few dozen curated
-- garments; shadow is the only mechanism that sees the actual mix sellers send.
--
-- Two things had to change in the schema, and neither is optional:
--   1. the results table cannot tell the two stages apart, so per-image rows
--      would be silently averaged into every existing composite query; and
--   2. block candidates (00563) had no shadow flags at all, so the one thing
--      US-2438 AC2 asks for could not be sampled even once.

-- ── grading_shadow_results: which stage, and what it cost ──────────────────

-- DEFAULT 'composite' is the correct backfill, not a convenience: every row
-- that exists today was written by the composite-only path.
ALTER TABLE public.grading_shadow_results
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'composite';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'grading_shadow_results_stage_check'
  ) THEN
    ALTER TABLE public.grading_shadow_results
      ADD CONSTRAINT grading_shadow_results_stage_check
      CHECK (stage IN ('per_image', 'composite'));
  END IF;
END $$;

-- A block candidate rather than a whole-system-prompt candidate. Nullable, and
-- mutually exclusive with shadow_prompt_version_id in practice — the
-- version_name column carries the `block:<key>[<scope>]=<version>` convention
-- US-2438 established for grading_eval_runs, so a reader never has to join to
-- find out which artifact ran.
ALTER TABLE public.grading_shadow_results
  ADD COLUMN IF NOT EXISTS shadow_block_version_id uuid
    REFERENCES public.ai_prompt_block_versions(id) ON DELETE SET NULL;

-- THE COST COLUMNS. A composite shadow row costs one cheap text call, so nobody
-- ever needed to count them. A per-image shadow row costs one VISION call per
-- photo plus one composite — six to eight paid calls for a normal submission.
-- Recording it per row is what makes the daily ceiling enforceable and the bill
-- explainable after the fact, instead of inferable from a row count and an
-- assumption about how many photos people upload.
ALTER TABLE public.grading_shadow_results
  ADD COLUMN IF NOT EXISTS images_analyzed integer;
ALTER TABLE public.grading_shadow_results
  ADD COLUMN IF NOT EXISTS vision_calls integer NOT NULL DEFAULT 0;

-- Per-factor deltas, the thing AC3 exists for. "The two results differed" is
-- what the prompt surface hash already says; a reviewer deciding whether to
-- promote needs to know WHICH factor moved and by how much, because a candidate
-- that shifts fabric_condition by 0.5 across the board is a different decision
-- from one that moves odor_cleanliness on a handful of items.
ALTER TABLE public.grading_shadow_results
  ADD COLUMN IF NOT EXISTS per_factor_deltas jsonb;
-- Tier disagreement is tracked separately from score agreement on purpose: a
-- 0.4 delta that crosses 7.95 flips Excellent to Very Good and is what the
-- seller actually sees, while a 0.5 delta inside a tier changes nothing visible.
ALTER TABLE public.grading_shadow_results
  ADD COLUMN IF NOT EXISTS tier_agreement boolean;

COMMENT ON COLUMN public.grading_shadow_results.stage IS
  'US-2443 which stage was re-run. composite = the champion per-image analyses were reused (one text call). per_image = every photo was re-analyzed under the challenger and re-composited (one vision call per photo plus one).';
COMMENT ON COLUMN public.grading_shadow_results.vision_calls IS
  'US-2443 paid vision calls this row cost. Zero for composite rows. The per-day ceiling is enforced as a SUM of this column, not a row count.';

CREATE INDEX IF NOT EXISTS idx_grading_shadow_results_stage_created
  ON public.grading_shadow_results(stage, created_at DESC);

-- ── ai_prompt_block_versions: the shadow flags it shipped without ──────────

-- 00563 mirrored ai_prompt_versions for is_active/is_canary/eval_passed but not
-- for shadow, because there was no per-image shadow path for a block to take.
-- Same column names and same semantics as ai_prompt_versions, so the resolver
-- and the cost guardrails read identically for both artifacts.
ALTER TABLE public.ai_prompt_block_versions
  ADD COLUMN IF NOT EXISTS is_shadow boolean NOT NULL DEFAULT false;
-- DEFAULT 0, not a small positive number. A row that becomes a shadow candidate
-- must have its rate set deliberately; inheriting a default sampling rate is how
-- a vision bill arrives before anyone has read a comparison.
ALTER TABLE public.ai_prompt_block_versions
  ADD COLUMN IF NOT EXISTS shadow_sample_rate numeric(5,4) NOT NULL DEFAULT 0
    CHECK (shadow_sample_rate >= 0 AND shadow_sample_rate <= 1);
ALTER TABLE public.ai_prompt_block_versions
  ADD COLUMN IF NOT EXISTS shadow_daily_cap integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ai_prompt_block_versions.shadow_sample_rate IS
  'US-2443 fraction of submissions this candidate shadows. Defaults to 0 so a new row costs nothing until someone chooses a rate. Per-image shadow is a vision call per photo — single digits of a percent is the intended range.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00566') on conflict do nothing;
