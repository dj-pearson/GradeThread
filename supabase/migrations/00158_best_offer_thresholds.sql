-- US-562: best-offer auto-accept / auto-decline thresholds.
--
-- Best Offer was a bare boolean (listings.best_offer_enabled); eBay never
-- received auto-clear thresholds, so every offer waited on the seller. We now
-- send autoAcceptPrice/autoDeclinePrice on the offer, derived from the
-- comp-range columns (price_range_low_cents = p25 floor, price_range_high_cents
-- = p75) added in 00153, and let the seller override either per item from the
-- AutoLister bulk editor. Both are stored in CENTS to match the comp columns.
-- NULL means "use the comp-derived default"; the publish path clamps whatever
-- it resolves to eBay's constraint (decline < accept < listing price).

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS best_offer_auto_accept_cents  integer,
  ADD COLUMN IF NOT EXISTS best_offer_auto_decline_cents integer;

COMMENT ON COLUMN public.listings.best_offer_auto_accept_cents IS
  'US-562: per-listing best-offer auto-ACCEPT threshold in cents. An offer at or above this auto-accepts. NULL → derive from comp p75. Clamped below listing price at publish.';
COMMENT ON COLUMN public.listings.best_offer_auto_decline_cents IS
  'US-562: per-listing best-offer auto-DECLINE threshold in cents. An offer at or below this auto-declines. NULL → derive from comp p25. Clamped below the accept threshold at publish.';
