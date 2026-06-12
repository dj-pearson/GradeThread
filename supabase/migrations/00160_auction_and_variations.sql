-- US-568: auction format + multi-variant (size/color) listings.
--
-- The publish path was hardcoded to FIXED_PRICE with a single SKU. eBay's
-- Inventory API also supports AUCTION offers (start/reserve/buy-it-now price +
-- a listing duration) and multi-variant listings (one logical listing backed by
-- an inventory_item_group of per-variant SKUs). These columns let a draft pick
-- its format and define its variation matrix; the publish path reads them.
--
-- Money is stored in CENTS to match the existing best-offer / comp columns.
-- listing_format defaults to 'fixed_price' so every existing row keeps its
-- current behaviour.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS listing_format text NOT NULL DEFAULT 'fixed_price',
  ADD COLUMN IF NOT EXISTS auction_start_price_cents       integer,
  ADD COLUMN IF NOT EXISTS auction_reserve_price_cents     integer,
  ADD COLUMN IF NOT EXISTS auction_buy_it_now_price_cents  integer,
  ADD COLUMN IF NOT EXISTS auction_duration text,
  -- Variation matrix: { specifications: string[], variants: [{ aspects, quantity, price_cents?, sku_suffix? }] }
  ADD COLUMN IF NOT EXISTS variations jsonb;

-- Guard the format against typos; only the two eBay listing types we support.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'listings_listing_format_check'
  ) THEN
    ALTER TABLE public.listings
      ADD CONSTRAINT listings_listing_format_check
      CHECK (listing_format IN ('fixed_price', 'auction'));
  END IF;
END $$;

COMMENT ON COLUMN public.listings.listing_format IS
  'US-568: eBay offer format — ''fixed_price'' (Buy It Now, default) or ''auction''.';
COMMENT ON COLUMN public.listings.auction_start_price_cents IS
  'US-568: auction starting bid in cents. Required when listing_format = ''auction''.';
COMMENT ON COLUMN public.listings.auction_reserve_price_cents IS
  'US-568: optional auction reserve price in cents (eBay hides the listing until met).';
COMMENT ON COLUMN public.listings.auction_buy_it_now_price_cents IS
  'US-568: optional Buy It Now price on an auction in cents (must exceed start price).';
COMMENT ON COLUMN public.listings.auction_duration IS
  'US-568: eBay listingDuration enum for auctions, e.g. DAYS_7. NULL → DAYS_7 default.';
COMMENT ON COLUMN public.listings.variations IS
  'US-568: multi-variant matrix as JSON { specifications: string[], variants: [{ aspects: Record<string,string>, quantity: number, price_cents?: number, sku_suffix?: string }] }. NULL/empty → single-SKU listing.';
