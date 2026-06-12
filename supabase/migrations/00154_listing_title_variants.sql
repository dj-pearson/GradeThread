-- US-546 (AC2 + AC3): demand-driven titles + A/B title variants.
--
-- AC2: AutoLister now mines high-demand eBay SEARCH terms (from live comp
-- titles for the item's brand/category) and feeds them into the title/
-- description generation prompt. demand_terms records the exact terms fed in,
-- for transparency and prompt-quality debugging.
--
-- AC3: the generator returns an OPTIONAL alternate title in the same AI call
-- (zero extra cost). title_variants stores both labelled variants
-- ([{label:'A', title, active}, {label:'B', title, active}]); active_title_variant
-- is the label currently live on the listing. Per-variant sell-through is rolled
-- up from these by summarizeTitleVariantSellThrough (demand-terms.ts) so a
-- better-converting title can be promoted later.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS title_variants       jsonb,
  ADD COLUMN IF NOT EXISTS active_title_variant text DEFAULT 'A',
  ADD COLUMN IF NOT EXISTS demand_terms         text[];

COMMENT ON COLUMN public.listings.title_variants IS
  'US-546: A/B title variants [{label, title, active}]; "A" is the published title, "B" the optional AI alternate.';
COMMENT ON COLUMN public.listings.active_title_variant IS
  'US-546: label (A/B) of the title variant currently live on this listing.';
COMMENT ON COLUMN public.listings.demand_terms IS
  'US-546: high-demand eBay search terms mined from live comps and fed into the title/description prompt.';
