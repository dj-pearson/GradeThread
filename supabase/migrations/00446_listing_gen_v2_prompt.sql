-- US-1900: register the listing_gen_v2 prompt version (INACTIVE).
--
-- v2 adds verified eBay policy title rules (no cross-brand comparison, no
-- duplicate title token, prefer buyer-typed qualifiers over aspect-carried
-- tokens) and AI-summary-era description guidance. Its text lives in code
-- (services/edge-functions/src/lib/ai-listing.ts:LISTING_GEN_SYSTEM_PROMPT_V2)
-- and is resolved from this row's version_name by resolvePromptText(), so the
-- row carries EMPTY prompt_text — exactly like the seeded listing_gen_v1 row
-- (migration 00053).
--
-- Seeded INACTIVE / not-in-trial: v2 goes through the existing lifecycle
-- (runListingEval sets eval_passed; an operator flips in_trial for the A/B
-- acceptance loop; activatePromptVersion promotes it). This NEVER hot-swaps the
-- live v1 prompt — v1 stays the champion until v2 clears the gate.

-- version_name has no unique constraint (see migration 00003), so ON CONFLICT
-- can't dedupe — guard with NOT EXISTS so re-applying never duplicates the row.
INSERT INTO public.ai_prompt_versions (version_name, prompt_text, stage, is_active, notes)
SELECT
  'listing_gen_v2', '', 'listing_gen', false,
  'US-1900 v-next: policy title rules (no cross-brand comparison, no duplicate '
  'title token, prefer buyer-typed qualifiers) + AI-summary-era description '
  'guidance. Text in code (ai-listing.ts LISTING_GEN_SYSTEM_PROMPT_V2). Inactive '
  'until it clears the listing-eval gate; do not hot-swap v1.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_prompt_versions
  WHERE version_name = 'listing_gen_v2' AND stage = 'listing_gen'
);

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00446') ON CONFLICT DO NOTHING;
