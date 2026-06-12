-- US-565: post-publish performance feedback loop.
--
-- US-151 added per-listing SNAPSHOT columns to public.listings (views_total,
-- watchers_count, impressions_7d, click_through_rate, view_trend_7d) that the
-- 6-hourly getTrafficReport sync overwrites in place. That's enough for the
-- live dashboard but keeps no history.
--
-- listing_metrics is the time-series behind those snapshots: the same sync
-- upserts ONE row per (listing, metric_date) so we retain a real per-day
-- history of impressions / views / watchers / CTR. That history is what powers
-- the performance suggestions ("low CTR → fix title/photo", "watched but unsold
-- → drop price / enable Best Offer") and the engagement signal fed into the
-- repricing engine.
--
-- Multi-tenant table → RLS (own data). The edge service uses the service-role
-- client (bypasses RLS); the sync still tenant-scopes every write and stamps
-- user_id on each row (CLAUDE.md US-268).

CREATE TABLE IF NOT EXISTS public.listing_metrics (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id         uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  metric_date        date NOT NULL,
  impressions        integer NOT NULL DEFAULT 0,
  views              integer NOT NULL DEFAULT 0,
  watchers           integer NOT NULL DEFAULT 0,
  -- 0..1 fraction (eBay returns a %, the sync divides by 100). NULL when eBay
  -- reported no CTR for the window.
  click_through_rate numeric(6,4),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- One snapshot per listing per day; the sync upserts (latest wins).
  UNIQUE (listing_id, metric_date)
);

-- The suggestion/repricing readers fetch the latest row per listing; the user
-- index backs the per-owner "my performance" scan.
CREATE INDEX IF NOT EXISTS idx_listing_metrics_listing_date
  ON public.listing_metrics(listing_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_listing_metrics_user_id
  ON public.listing_metrics(user_id);

DROP TRIGGER IF EXISTS set_listing_metrics_updated_at ON public.listing_metrics;
CREATE TRIGGER set_listing_metrics_updated_at
  BEFORE UPDATE ON public.listing_metrics
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.listing_metrics ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS, so DROP first to stay re-runnable.
-- Read-only to owners; all writes go through the service-role sync.
DROP POLICY IF EXISTS "Users can view own listing metrics" ON public.listing_metrics;
CREATE POLICY "Users can view own listing metrics"
  ON public.listing_metrics FOR SELECT USING (auth.uid() = user_id);
