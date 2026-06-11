-- Listing-performance metrics sync (US-151).
--
-- Engagement metrics per active eBay listing, pulled from the Sell Analytics
-- getTrafficReport API every 6 hours by the /api/flipdesk/ebay/sync/performance
-- cron. Lets a reseller spot duds (listed a while, no views/watchers) before
-- they age out.
--
-- New listing columns hold the latest snapshot; view_trend_7d is a rolling
-- per-day array of views_total snapshots (latest wins per day, last 7 kept) so
-- the dashboard can draw a sparkline without a separate history table.
--
-- Sell Analytics is a separate eBay API grant beyond basic OAuth. When a
-- seller's token lacks the sell.analytics.readonly scope the sync flips
-- marketplace_connections.analytics_access_denied so the UI can prompt a
-- reconnect instead of silently showing zeros.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS views_total           integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watchers_count         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS impressions_7d         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS click_through_rate     numeric(6,4),
  ADD COLUMN IF NOT EXISTS last_metrics_synced_at timestamptz,
  -- [{ "date": "2026-06-10", "views": 42 }, ...] — oldest→newest, max 7.
  ADD COLUMN IF NOT EXISTS view_trend_7d          jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Stale-listings widget (US-127) and "no views in N days" filter chip both
-- range-scan active listings by listed_at; the partial index keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_listings_active_listed_at
  ON public.listings(listed_at)
  WHERE listing_status = 'active';

-- Per-connection flag: set when getTrafficReport 403s for missing Sell
-- Analytics access so the UI can surface a one-time reconnect prompt.
ALTER TABLE public.marketplace_connections
  ADD COLUMN IF NOT EXISTS analytics_access_denied boolean NOT NULL DEFAULT false;
