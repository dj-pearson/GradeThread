-- US-308: Google Search Console search-performance ingestion.
--
-- Stores daily row-level data from GSC's Search Analytics API: per page +
-- query + country + device tuple, the impressions / clicks / CTR / position.
-- Drives the admin SEO dashboard (US-309) — we never expose this to end
-- users; it's platform-level data about how the site ranks.
--
-- Idempotent ingestion: the unique key lets the daily sync upsert without
-- duplicating rows when a backfill overlaps yesterday's pull.

CREATE TABLE IF NOT EXISTS public.gsc_performance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Day the metrics cover. GSC reports in YYYY-MM-DD UTC.
  date              date NOT NULL,
  -- The site property GSC reported on (sc-domain:gradethread.com or
  -- the URL prefix). Lets us track multiple properties without conflict.
  site_url          text NOT NULL,
  -- Dimensions from the query. NULL = "all" for that dimension.
  page              text,
  query             text,
  country           text, -- ISO 3166-1 alpha-3 (GSC returns lowercase 3-letter)
  device            text, -- DESKTOP, MOBILE, TABLET
  -- Metrics.
  impressions       integer NOT NULL DEFAULT 0,
  clicks            integer NOT NULL DEFAULT 0,
  ctr               numeric(10, 6) NOT NULL DEFAULT 0,
  "position"        numeric(10, 4) NOT NULL DEFAULT 0,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gsc_performance_unique
    UNIQUE (date, site_url, page, query, country, device)
);

CREATE INDEX IF NOT EXISTS idx_gsc_performance_date
  ON public.gsc_performance (date DESC);
CREATE INDEX IF NOT EXISTS idx_gsc_performance_query
  ON public.gsc_performance (query, date DESC) WHERE query IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gsc_performance_page
  ON public.gsc_performance (page, date DESC) WHERE page IS NOT NULL;

-- Admin-only data. Service-role bypasses RLS for the ingestion job; no
-- anon/authenticated grants — the admin dashboard reads via the edge
-- service which acts as service-role.
ALTER TABLE public.gsc_performance ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.gsc_performance IS
  'Daily GSC Search Analytics rows (US-308). One row per '
  '(date, site_url, page, query, country, device) tuple. Idempotently '
  'upserted by the gsc-sync cron job; never user-scoped.';
