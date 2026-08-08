-- US-2438: a versioned artifact for the grading USER message, keyed per BLOCK.
--
-- Only the SYSTEM prompt has ever been versioned. Everything assembled into the
-- user message — the garment-type criteria, the category criteria, the baseline
-- and fabric blocks, the response schema — reaches sellers on the next deploy
-- with an env flag as its only control. A flag is a switch, not a gate: it can
-- turn a block off again, but nothing measures it against the golden set first.
--
-- WHY THIS IS A SECOND TABLE AND NOT MORE ROWS IN ai_prompt_versions. That table
-- has had garment_scope since 00050 and resolves it as a WHOLE-TEXT override —
-- scoped row, else global row, else the code default, with no composition. So a
-- row that wanted to change only CATEGORY CRITERIA for jeans would have to carry
-- a full copy of the ~90-line response schema and the Rules block with it, and
-- with 19 categories scoped, 19 copies of one invariant. That is the same shape
-- as the two title-sync copies (US-1995): duplicate an invariant across N homes
-- and they drift, with nothing able to say which one a given grade ran under.
-- The reasoning is recorded in full at vault/20-domain/grading-prompt-channels.md
-- ("The seam decision"); it was decided in US-2432 and must not be re-derived.
--
-- The columns deliberately mirror ai_prompt_versions one-for-one — same
-- is_active/is_canary/rollout_percentage/eval_passed shape — because the SAME
-- resolver reads both (resolveSlotFromRows in canary-rollout.ts). A block row
-- that resolved by its own rules would be a parallel resolver, which is the
-- thing this design is trying not to build.

CREATE TABLE IF NOT EXISTS public.ai_prompt_block_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-readable, e.g. "category_criteria_jeans_v2". Stamped on the grade so
  -- a run is attributable to the exact block text that produced it.
  version_name       text NOT NULL,
  stage              text NOT NULL
    CHECK (stage IN ('per_image', 'composite')),
  -- Which block of the user message this row replaces. The vocabulary is CLOSED
  -- and lives in code (prompt-blocks.ts PROMPT_BLOCK_KEYS) — a row naming a key
  -- the code does not know is inert, never an error, so a typo silently does
  -- nothing rather than silently replacing the wrong block.
  block_key          text NOT NULL,
  -- NULL = every garment. Otherwise the scope value for THIS block's dimension:
  -- garment_type for garment_type_criteria, garment_category for
  -- category_criteria. Which dimension a key scopes by is code's decision, not
  -- this column's — the column only holds the value to match.
  garment_scope      text,
  -- Empty string means "use the code default text but attribute the grade to
  -- this version_name", exactly as ai_prompt_versions.prompt_text does. That is
  -- how a code default gets a name without duplicating it into a row.
  block_text         text NOT NULL DEFAULT '',
  is_active          boolean NOT NULL DEFAULT false,
  -- A canary is NOT the champion: is_active stays false while it takes a slice.
  is_canary          boolean NOT NULL DEFAULT false,
  rollout_percentage integer NOT NULL DEFAULT 0
    CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
  rollout_started_at timestamptz,
  -- Did this block clear the golden-set gate? Activation is gated on it the same
  -- way a system prompt is.
  eval_passed        boolean,
  eval_run_id        uuid,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_prompt_block_versions IS
  'US-2438: per-block versioned overrides for the grading USER message. Keyed '
  '(stage, block_key, garment_scope). An empty registry leaves every prompt '
  'byte-identical to the code defaults — the seam is additive.';
COMMENT ON COLUMN public.ai_prompt_block_versions.block_key IS
  'Closed vocabulary defined in code (prompt-blocks.ts). An unknown key is '
  'inert: it resolves nothing rather than replacing the wrong block.';
COMMENT ON COLUMN public.ai_prompt_block_versions.block_text IS
  'Empty = use the code default text under this version_name.';

-- One ACTIVE and one CANARY row per (stage, block_key, scope) slot, mirroring
-- the partial unique indexes 00050/00221 put on ai_prompt_versions. COALESCE so
-- the NULL (global) scope collapses to a single slot rather than one per NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_block_active_slot
  ON public.ai_prompt_block_versions(stage, block_key, COALESCE(garment_scope, ''))
  WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_block_canary_slot
  ON public.ai_prompt_block_versions(stage, block_key, COALESCE(garment_scope, ''))
  WHERE is_canary = true;

-- The runtime reads every active/canary row for a stage in ONE query and
-- resolves each block from that set in memory, so this index covers the read.
CREATE INDEX IF NOT EXISTS idx_prompt_block_stage_live
  ON public.ai_prompt_block_versions(stage)
  WHERE is_active = true OR is_canary = true;

-- ── RLS: admins READ, only the service role WRITES ──
--
-- This mirrors ai_prompt_versions as it is TODAY, which is not how 00003 left
-- it. 00003 granted every is_admin() caller full INSERT/UPDATE/DELETE, and
-- US-2348 (migration 00510) revoked all three, because that grant let the admin
-- SPA write the table directly and so reach around the router scope guard, the
-- MFA step-up on activate, the audit row, and the whole shadow/eval/canary
-- lifecycle. Reads were deliberately left open so the admin UI keeps working.
--
-- Copying 00003's four policies here would have re-opened that hole on a table
-- holding LIVE GRADING PROMPT TEXT — an admin with a revoked grading:review
-- scope could insert `is_active = true` from a browser and move every grade the
-- platform issues. Same bug, new table, and it would not have tripped a single
-- existing guard. So: SELECT only, and no write policy at all. With RLS on and
-- no permissive policy for a command, that command is denied for every non-
-- service role; the edge writes through the service-role client, which bypasses
-- RLS entirely.
ALTER TABLE public.ai_prompt_block_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view AI prompt blocks" ON public.ai_prompt_block_versions;
CREATE POLICY "Admins can view AI prompt blocks"
  ON public.ai_prompt_block_versions FOR SELECT
  USING (public.is_admin());

-- Defensive: if an earlier hand-run of a draft of this file created write
-- policies, drop them. Re-running the directory must converge on the posture
-- above rather than on whatever an intermediate version left behind.
DROP POLICY IF EXISTS "Admins can create AI prompt blocks" ON public.ai_prompt_block_versions;
DROP POLICY IF EXISTS "Admins can update AI prompt blocks" ON public.ai_prompt_block_versions;
DROP POLICY IF EXISTS "Admins can delete AI prompt blocks" ON public.ai_prompt_block_versions;

insert into public.applied_migrations (version) values ('00563') on conflict do nothing;
