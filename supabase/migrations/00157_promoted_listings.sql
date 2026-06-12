-- Promoted Listings at publish (US-561).
--
-- The sell.marketing OAuth scope has been granted since the first eBay
-- integration but went entirely unused — zero Promoted Listings. Promoted
-- Listings is eBay's biggest seller-side visibility lever: a Cost-Per-Sale ad
-- campaign attaches a bid percentage (the "ad rate") to a listing and the
-- seller is charged that percentage of the sale price ONLY when the item sells
-- through the ad. Because there's no up-front cost, FlipDesk attaches a
-- category-suggested ad rate by default at publish; the seller can adjust the
-- rate (listings.promo_rate_pct, added in 00135) or opt out per listing.
--
-- promo_rate_pct (00135) already holds the seller's chosen/accepted rate. This
-- migration adds the opt-out flag, the eBay-side handles created at publish, and
-- the post-publish performance fields surfaced back to the seller.

-- Per-listing opt-out from promotion. When false (the default) and the listing
-- is published, FlipDesk attaches an ad at promo_rate_pct (or the category
-- suggestion when null). When true, publish skips promotion entirely.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS promo_opt_out boolean NOT NULL DEFAULT false;

-- eBay Promoted Listings handles, populated at publish by the Marketing API.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS promo_campaign_id text;
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS promo_ad_id text;

-- Lifecycle of the ad: null (not promoted) | 'active' | 'failed' | eBay's own
-- adStatus echoed back by the performance sync (e.g. 'RUNNING', 'PAUSED').
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS promo_status text;

-- Post-publish performance surfaced to the seller. promo_ad_fees_cents is the
-- accrued ad spend (charged only on sale); promo_synced_at anchors the last
-- Marketing API performance refresh.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS promo_ad_fees_cents integer NOT NULL DEFAULT 0;
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS promo_synced_at timestamptz;

-- The performance sync walks listings that have a live ad. Partial index keeps
-- the scan cheap on large catalogs where most listings aren't promoted.
CREATE INDEX IF NOT EXISTS idx_listings_promo_active
  ON public.listings (user_id)
  WHERE promo_ad_id IS NOT NULL;

-- Cache the seller's default Promoted Listings campaign id on the connection so
-- ensureAdCampaign doesn't round-trip eBay's "find campaign by name" on every
-- publish. Created once per seller (a single COST_PER_SALE campaign holds all
-- of their FlipDesk ads).
ALTER TABLE public.marketplace_connections
  ADD COLUMN IF NOT EXISTS ebay_campaign_id text;
