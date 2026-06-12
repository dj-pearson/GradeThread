-- US-542: price from sold comps, not active asking prices.
--
-- AutoLister priced from active eBay asking prices yet flagged the price as
-- non-estimated. Pricing now prefers REALIZED/sold comps (eBay Marketplace
-- Insights or the seller's own sales table as a private comp set) and only
-- clears price_is_estimated when the price is sold-backed. These columns record
-- the resulting price RANGE, a confidence score, and which comp source produced
-- the price so the UI can surface the limitation when it falls back to active
-- asking prices.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS price_range_low_cents  integer,
  ADD COLUMN IF NOT EXISTS price_range_high_cents integer,
  ADD COLUMN IF NOT EXISTS price_confidence       numeric,
  -- One of: 'ai_estimate' | 'active_asking' | 'private_sales' | 'ebay_sold'.
  ADD COLUMN IF NOT EXISTS price_comp_source      text;

COMMENT ON COLUMN public.listings.price_range_low_cents IS
  'US-542: low end (p25) of the comp-derived price range, in cents.';
COMMENT ON COLUMN public.listings.price_range_high_cents IS
  'US-542: high end (p75) of the comp-derived price range, in cents.';
COMMENT ON COLUMN public.listings.price_confidence IS
  'US-542: 0..1 confidence in the suggested price; higher for sold-backed comps.';
COMMENT ON COLUMN public.listings.price_comp_source IS
  'US-542: where the price came from — ai_estimate | active_asking (asking prices, not realized) | private_sales | ebay_sold.';
