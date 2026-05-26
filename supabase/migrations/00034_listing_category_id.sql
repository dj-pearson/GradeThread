-- FlipDesk → eBay: store the leaf category each live listing is in.
--
-- Captured from offer.categoryId (Sell Inventory API) on sync. Also written
-- on first publish so post-publish reads + check-category analyses don't
-- need to round-trip eBay just to know where the listing was put.
--
-- The category NAME is resolved on demand against the
-- public.ebay_category_aspects cache (it already keys on category_id and
-- has a category_name column from migration 00030). When a listing's
-- category is fetched, the name is looked up there first; only when missing
-- do we hit the Taxonomy API.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS platform_category_id text;

CREATE INDEX IF NOT EXISTS idx_listings_platform_category_id
  ON public.listings(platform_category_id)
  WHERE platform_category_id IS NOT NULL;
