-- US-314: AutoLister business-policy + merchant-location caching.
--
-- business_policies (added in 00052) already holds per-policy rows with an
-- is_default flag. The remaining piece of publish context — merchant location
-- key — lives one-per-seller, so it belongs on marketplace_connections.
-- Storing it here lets assemblePublishContext skip a live eBay round-trip on
-- every publish, falling back to the live fetch only when the cache is empty.

ALTER TABLE public.marketplace_connections
  ADD COLUMN IF NOT EXISTS merchant_location_key text;

COMMENT ON COLUMN public.marketplace_connections.merchant_location_key IS
  'Cached default Sell Inventory location key for this seller (US-314). '
  'Resolved on first /policies sync; used by publish to avoid a per-call lookup.';
