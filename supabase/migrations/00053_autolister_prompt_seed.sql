-- FlipDesk AutoLister (US-311): register the listing-generation prompt stage.
--
-- ai_prompt_versions.stage was constrained to ('per_image','composite') by
-- migration 00050. AutoLister adds a third stage, 'listing_gen', whose active
-- row OVERRIDES the in-code listing prompt (services/edge-functions/src/lib/
-- ai-listing.ts) for no-deploy iteration + eval-gated A/B testing.
--
-- We seed an INACTIVE listing_gen_v1 row (empty prompt_text = "use the code
-- default text, attribute to this version_name"). Like grading prompts, a
-- candidate stays inactive until it clears the eval gate (eval_passed = true).

-- ── 1. Widen the stage CHECK constraint to include 'listing_gen' ──────
-- The constraint is unnamed in 00050 (inline CHECK on ADD COLUMN), so Postgres
-- generated a name. Find and drop it, then re-add the widened constraint.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.ai_prompt_versions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%stage%per_image%composite%';

  IF con_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.ai_prompt_versions DROP CONSTRAINT %I',
      con_name
    );
  END IF;

  -- Re-add (idempotent: drop our named one first if a prior run created it).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_prompt_versions_stage_check'
      AND conrelid = 'public.ai_prompt_versions'::regclass
  ) THEN
    ALTER TABLE public.ai_prompt_versions
      DROP CONSTRAINT ai_prompt_versions_stage_check;
  END IF;

  ALTER TABLE public.ai_prompt_versions
    ADD CONSTRAINT ai_prompt_versions_stage_check
    CHECK (stage IN ('per_image', 'composite', 'listing_gen'));
END $$;

-- ── 2. Seed the in-code default listing prompt version (inactive) ─────
-- version_name has no unique constraint (see migration 00003), so ON CONFLICT
-- can't dedupe — guard with NOT EXISTS so re-applying never duplicates the row.
INSERT INTO public.ai_prompt_versions (version_name, prompt_text, stage, is_active, notes)
SELECT
  'listing_gen_v1', '', 'listing_gen', false,
  'In-code default (ai-listing.ts generateListingFields). Seeded so AutoLister '
  'generations can be attributed and a DB override can be eval-gated before activation.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_prompt_versions
  WHERE version_name = 'listing_gen_v1' AND stage = 'listing_gen'
);
