-- US-2233 AC3/AC4: server-side aggregate + paged search for Listing Performance.
--
-- The page had to load EVERY active eBay listing into the browser, because the
-- three KPI tiles are computed across the whole set. Search, sort and paging
-- then ran client-side over that array. These two functions move both halves
-- into the database so the browser can ask for one page.
--
-- SECURITY INVOKER (the default, stated for the reader): both run as the
-- CALLING role, so the existing RLS on listings and inventory_items is what
-- scopes them to the seller. No SECURITY DEFINER, therefore no tenant filter to
-- forget and nothing for US-2282's grant guard to carry.

-- Aggregate across every active eBay listing the caller can see.
--
-- DROP first: CREATE OR REPLACE cannot change a function s RETURN TYPE, and
-- this one gained last_synced_at during development. Dropping by full signature
-- keeps the file re-runnable on a database that already has either shape, which
-- is what idempotent has to mean here (US-1108 rule 1).
DROP FUNCTION IF EXISTS public.flipdesk_listing_performance_summary();
CREATE OR REPLACE FUNCTION public.flipdesk_listing_performance_summary()
RETURNS TABLE (
  total_listings bigint,
  total_views    bigint,
  avg_ctr        numeric,
  stale_count    bigint,
  -- The page header shows "last synced"; with server-side paging the client no
  -- longer holds every row to take a max over, so it comes from here.
  last_synced_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    count(*)::bigint,
    coalesce(sum(coalesce(l.views_total, 0)), 0)::bigint,
    -- AVG over the rows that HAVE a rate. avg() already skips NULLs, which is
    -- the same rule the client used: a listing eBay has not reported a CTR for
    -- must not be averaged in as a zero, or a fresh catalog reads as 0% CTR.
    avg(l.click_through_rate),
    count(*) FILTER (
      WHERE coalesce(l.views_total, 0) = 0
        AND l.listed_at IS NOT NULL
        AND l.listed_at <= now() - interval '14 days'
    )::bigint,
    max(l.last_metrics_synced_at)
  FROM public.listings l
  WHERE l.platform = 'ebay'
    AND l.listing_status = 'active';
$$;

COMMENT ON FUNCTION public.flipdesk_listing_performance_summary() IS
  'US-2233: KPI tiles for Listing Performance. SECURITY INVOKER so RLS scopes it to the caller.';

-- One page of the report, searched and sorted in the database.
--
-- p_no_view_days: 0 = off; otherwise only listings with zero views that have
--   been listed at least that many days.
-- p_sort: one of views_total, watchers_count, impressions_7d,
--   click_through_rate, listing_price, listed_at. Anything else falls back to
--   views_total rather than erroring — a stale bookmark must not 500.
--
-- total_count rides on every row so the caller gets the page and the page count
-- in ONE round trip. A separate count query would be a second read that can
-- disagree with the page it labels.
CREATE OR REPLACE FUNCTION public.flipdesk_listing_performance_page(
  p_search       text    DEFAULT NULL,
  p_no_view_days integer DEFAULT 0,
  p_sort         text    DEFAULT 'views_total',
  p_desc         boolean DEFAULT true,
  p_limit        integer DEFAULT 50,
  p_offset       integer DEFAULT 0
)
RETURNS TABLE (
  id                     uuid,
  inventory_item_id      uuid,
  title                  text,
  listing_url            text,
  listing_price          numeric,
  listed_at              timestamptz,
  views_total            integer,
  watchers_count         integer,
  impressions_7d         integer,
  click_through_rate     numeric,
  last_metrics_synced_at timestamptz,
  view_trend_7d          jsonb,
  total_count            bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      l.id,
      l.inventory_item_id,
      -- The title fallback the client used to do in a second query: blank
      -- listing_title resolves to the inventory item's title. Doing it here is
      -- what makes SEARCH correct — a client-side search over listing_title
      -- alone silently missed every listing whose title came from the item.
      nullif(btrim(coalesce(l.listing_title, '')), '') AS listing_title,
      i.title AS item_title,
      l.listing_url,
      l.listing_price,
      l.listed_at,
      l.views_total,
      l.watchers_count,
      l.impressions_7d,
      l.click_through_rate,
      l.last_metrics_synced_at,
      l.view_trend_7d
    FROM public.listings l
    LEFT JOIN public.inventory_items i ON i.id = l.inventory_item_id
    WHERE l.platform = 'ebay'
      AND l.listing_status = 'active'
  ),
  resolved AS (
    SELECT
      b.*,
      coalesce(b.listing_title, b.item_title, '') AS resolved_title
    FROM base b
  ),
  filtered AS (
    SELECT r.*
    FROM resolved r
    WHERE (
        p_search IS NULL
        OR btrim(p_search) = ''
        -- ESCAPED: a seller searching for a title containing % or _ must not
        -- get a wildcard match. `\` is the default LIKE escape character.
        OR r.resolved_title ILIKE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
      AND (
        coalesce(p_no_view_days, 0) <= 0
        OR (
          coalesce(r.views_total, 0) = 0
          AND r.listed_at IS NOT NULL
          AND r.listed_at <= now() - make_interval(days => p_no_view_days)
        )
      )
  )
  SELECT
    f.id,
    f.inventory_item_id,
    f.resolved_title,
    f.listing_url,
    f.listing_price,
    f.listed_at,
    f.views_total,
    f.watchers_count,
    f.impressions_7d,
    f.click_through_rate,
    f.last_metrics_synced_at,
    f.view_trend_7d,
    count(*) OVER ()::bigint AS total_count
  FROM filtered f
  ORDER BY
    -- NULLS LAST in both directions: a listing eBay has never reported on is
    -- missing data, not a top or bottom performer, and floating it to the head
    -- of a "most viewed" report would be a wrong answer rather than an empty one.
    -- p_sort <> 'title' guards the ELSE below: without it a title sort would
    -- still order by views_total first and use the title only as a tiebreak.
    CASE WHEN p_desc AND p_sort <> 'title' THEN
      CASE p_sort
        WHEN 'watchers_count'     THEN f.watchers_count::numeric
        WHEN 'impressions_7d'     THEN f.impressions_7d::numeric
        WHEN 'click_through_rate' THEN f.click_through_rate
        WHEN 'listing_price'      THEN f.listing_price
        WHEN 'listed_at'          THEN extract(epoch FROM f.listed_at)
        ELSE f.views_total::numeric
      END
    END DESC NULLS LAST,
    CASE WHEN NOT p_desc AND p_sort <> 'title' THEN
      CASE p_sort
        WHEN 'watchers_count'     THEN f.watchers_count::numeric
        WHEN 'impressions_7d'     THEN f.impressions_7d::numeric
        WHEN 'click_through_rate' THEN f.click_through_rate
        WHEN 'listing_price'      THEN f.listing_price
        WHEN 'listed_at'          THEN extract(epoch FROM f.listed_at)
        ELSE f.views_total::numeric
      END
    END ASC NULLS LAST,
    -- Title sorts as TEXT, which cannot share the numeric CASE above without
    -- casting a title to a number. Kept as its own pair so the numeric columns
    -- stay numeric — sorting views as text would put 9 above 120.
    CASE WHEN p_sort = 'title' AND p_desc THEN lower(f.resolved_title) END DESC NULLS LAST,
    CASE WHEN p_sort = 'title' AND NOT p_desc THEN lower(f.resolved_title) END ASC NULLS LAST,
    -- Deterministic tiebreak. Without it two rows with equal views can swap
    -- between pages, so paging would show one twice and skip another.
    f.id
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  OFFSET greatest(0, coalesce(p_offset, 0));
$$;

COMMENT ON FUNCTION public.flipdesk_listing_performance_page(text, integer, text, boolean, integer, integer) IS
  'US-2233: one searched, sorted, paged page of Listing Performance. SECURITY INVOKER — RLS scopes it.';

-- Both are called from the browser by the signed-in seller. Explicit, because
-- silence on this stack means "whatever the Supabase default happens to be"
-- (US-2282), and anon has no business calling either.
REVOKE ALL ON FUNCTION public.flipdesk_listing_performance_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.flipdesk_listing_performance_page(text, integer, text, boolean, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flipdesk_listing_performance_summary() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.flipdesk_listing_performance_page(text, integer, text, boolean, integer, integer) TO authenticated, service_role;

insert into public.applied_migrations (version) values ('00560') on conflict do nothing;
