-- FlipDesk → eBay: store the Sell API offerId alongside the listingId.
--
-- The listingId (already in platform_listing_id) identifies the live listing
-- buyers see. The offerId is the Sell API handle used to update price, end
-- the listing, or revise specifics without re-publishing. We persist it at
-- publish-time + during sync so end/price-update don't have to list_offers
-- by SKU every call.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS platform_offer_id text;

CREATE INDEX IF NOT EXISTS idx_listings_platform_offer_id
  ON public.listings(platform_offer_id)
  WHERE platform_offer_id IS NOT NULL;
