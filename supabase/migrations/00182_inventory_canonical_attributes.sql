-- US-821: Canonical attribute capture — extend the single AI extract pass to
-- capture the FULL listing field set in ONE call, so changing the eBay category
-- later (US-822 owns the per-category aspect mapping) never re-runs the AI.
--
-- Today ai-extract.ts extracts only the 9 core fields and emits a best-effort
-- eBay-aspect block, but several extracted signals are DROPPED:
--   * condition_summary  — returned to the client, never persisted.
--   * ebay_category_query — used transiently to resolve a category, then lost.
--   * the durable clothing aspects (Department, Size Type, Sleeve Length,
--     Neckline, Pattern, Fit, Closure, Features, Garment Care, Country of
--     Manufacture, Vintage, Theme, MPN) were never captured as durable fields.
--
-- This migration adds the durable home for all of them:
--   * inventory_items.attributes (jsonb) — CANONICAL key -> value/values map.
--     Keys are lowercase snake_case canonical names (NOT eBay aspect names —
--     US-822 maps canonical -> per-category eBay aspect downstream). Single
--     attributes store a scalar string ("Men"); multi attributes (features)
--     store a string[] (["Pockets","Hooded"]). Confidence + source for each
--     accepted attribute live in the existing ai_field_sources jsonb, keyed by
--     the same canonical name — exactly like the 9 core fields.
--   * inventory_items.condition_summary (text) — the AI's observed-condition
--     summary, now persisted for display + downstream copy.
--   * inventory_items.ebay_category_query (text) — the generic category search
--     phrase, persisted so a later category change can re-resolve without AI.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS guards re-runs.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS condition_summary text,
  ADD COLUMN IF NOT EXISTS ebay_category_query text;

-- GIN index so future per-category aspect reconciliation (US-822/US-828) can
-- query items by a captured canonical attribute without a full scan.
CREATE INDEX IF NOT EXISTS idx_inventory_items_attributes
  ON public.inventory_items USING gin (attributes);

COMMENT ON COLUMN public.inventory_items.attributes IS
  'US-821 canonical listing attributes: lowercase snake_case key -> value (string) or values (string[] for multi, e.g. features). NOT eBay aspect names — US-822 maps these to per-category eBay aspects.';
COMMENT ON COLUMN public.inventory_items.condition_summary IS
  'US-821 AI observed-condition summary (display + listing copy). Previously returned but never persisted.';
COMMENT ON COLUMN public.inventory_items.ebay_category_query IS
  'US-821 generic eBay category search phrase (item type + department, no brand/size/color). Persisted so a later category change can re-resolve without re-running AI.';
