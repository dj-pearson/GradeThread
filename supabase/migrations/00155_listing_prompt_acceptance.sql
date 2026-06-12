-- US-547: Self-improving listing prompt from seller-acceptance data.
--
-- Closes the loop the AutoLister rails were missing: capture per-field
-- keep/change on every published draft (acceptance signal), attribute it to the
-- listing_gen prompt version that produced the draft, and pair it with
-- sell-through so a challenger prompt can be A/B-tried and auto-promoted when it
-- demonstrably beats the incumbent on what sellers keep AND on what sells.
--
-- Rails already in place (do NOT recreate): ai_prompt_versions (00003/00050),
-- the listing_gen stage + listing_gen_v1 seed (00053), the listing eval gate
-- (00055 + lib/listing-eval.ts), ai_enrichment_log (00024).

-- 1. Snapshot the AI's generated fields on the draft so the acceptance diff at
--    publish time compares the model's output against the seller's final edits.
--    ai_prompt_version attributes the draft to the prompt that produced it
--    (champion or A/B challenger) — the unit the performance rollup groups by.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS ai_generated_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS ai_prompt_version text;

-- 2. A/B challenger flag on listing_gen prompt versions. The active row is the
--    champion; an eval-passed row flagged in_trial=true is the challenger and
--    receives a deterministic ~50% of generations (resolveListingPrompt splits
--    on the item id). Only ONE challenger per stage is meaningful at a time.
ALTER TABLE ai_prompt_versions
  ADD COLUMN IF NOT EXISTS in_trial boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;

-- 3. Per-draft acceptance signal, one row per generated+published listing.
CREATE TABLE IF NOT EXISTS listing_prompt_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  -- The listing_gen prompt version that produced the draft (e.g. listing_gen_v1).
  prompt_version text NOT NULL,
  -- The AI's generated values for the tracked fields (snapshot at generation).
  ai_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The seller-accepted final values at publish (post-edit).
  accepted_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-field outcome map: { title: 'kept' | 'changed', price: 'kept', ... }.
  field_outcomes jsonb NOT NULL DEFAULT '{}'::jsonb,
  kept_count integer NOT NULL DEFAULT 0,
  changed_count integer NOT NULL DEFAULT 0,
  total_fields integer NOT NULL DEFAULT 0,
  -- Sell-through: flipped true when the eBay orders-sync marks the listing sold.
  sold boolean NOT NULL DEFAULT false,
  sold_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One acceptance row per listing; a re-publish updates the same row.
  CONSTRAINT listing_prompt_acceptance_listing_uniq UNIQUE (listing_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_prompt_acceptance_version
  ON listing_prompt_acceptance (prompt_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listing_prompt_acceptance_user
  ON listing_prompt_acceptance (user_id, created_at DESC);

-- updated_at auto-managed (mirrors the project-wide trigger convention).
DROP TRIGGER IF EXISTS set_listing_prompt_acceptance_updated_at ON listing_prompt_acceptance;
CREATE TRIGGER set_listing_prompt_acceptance_updated_at
  BEFORE UPDATE ON listing_prompt_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: a seller may read their own acceptance rows (their listings feed it);
-- all writes go through the service-role edge client, which bypasses RLS.
ALTER TABLE listing_prompt_acceptance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own listing acceptance" ON listing_prompt_acceptance;
CREATE POLICY "Users read own listing acceptance"
  ON listing_prompt_acceptance FOR SELECT
  USING (auth.uid() = user_id);
