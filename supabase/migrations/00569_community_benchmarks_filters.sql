-- US-2235 AC1 + AC2: filters on the community benchmarks, and a count of who
-- is behind them.
--
-- Community Insights returned a fixed unfiltered snapshot, so a reseller asking
-- "how does Carhartt in size L move" had to read top-N lists and guess. The
-- previous pass on this story closed AC3 and AC4 client-side and recorded why
-- these two could not be: both need the RPC itself to change, because filtering
-- CLIENT-side over pre-aggregated k-anonymous output is not filtering at all —
-- the medians were computed over everyone, and hiding rows afterwards does not
-- recompute them.
--
-- ── WHY THIS DROPS AND RECREATES RATHER THAN OVERLOADING ────────────────────
-- CREATE OR REPLACE cannot add parameters; it would create a SECOND function
-- with a different arity. Both would then accept a single named p_period_start
-- (the new one via defaults), and PostgREST calls by NAME — so every existing
-- one-argument call would become ambiguous and fail at runtime, in production,
-- on a path no local test exercises. Dropping first is the only version of this
-- that has one function in it.
--
-- Idempotent: DROP IF EXISTS on the old signature, CREATE OR REPLACE on the new.
-- Safe to re-run, and safe to run on a database that already has the new one.
--
-- ── THE PRIVACY ARGUMENT, IN ONE PLACE ──────────────────────────────────────
-- Filtering is the classic way to break a k-anonymity guarantee: narrow the
-- cohort until one person is left, then read their numbers off the "aggregate".
-- The defence here is structural rather than a new check — the filters apply to
-- the BASE row set, so all fifteen existing `sellers >= min_sellers` guards
-- re-evaluate against the filtered cohort and return nulls. The floor itself is
-- unchanged: read from system_settings, hard-clamped to at least 5.
--
-- The body below is 00241's, unmodified except for the signature, the filter
-- predicate in `base`, and the two new `meta` keys.

BEGIN;

-- The old one-argument signature. Dropped, not left alongside — see the header.
DROP FUNCTION IF EXISTS public.community_benchmarks(date);

create or replace function public.community_benchmarks(
  p_period_start date default null,
  -- US-2235 AC1. All null (the default) = the unfiltered snapshot 00241
  -- returned, byte for byte. Text filters are case-insensitive exact matches on
  -- the SAME normalized expressions the aggregates group by, so "nike" selects
  -- exactly the cohort the topBrands row for "Nike" describes.
  p_brand text default null,
  p_category text default null,
  p_size text default null,
  -- Bounds on the LISTING price, which is the number a sourcing decision turns
  -- on. Sale price is an outcome; you cannot filter your sourcing by it.
  p_price_min numeric default null,
  p_price_max numeric default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    -- Configured threshold, clamped to a hard floor of 5. Never lets an operator
    -- weaken k-anonymity below the documented guarantee.
    select greatest(
      5,
      coalesce(
        (select nullif(value #>> '{}', '')::int
           from public.system_settings
          where key = 'community_min_cohort_sellers'),
        5
      )
    )::int as min_sellers
  ),
  base as (
    -- One row per inventory item, platform-wide, with its latest listing/sale.
    select
      i.user_id,
      coalesce(nullif(trim(i.brand), ''), 'No brand') as brand,
      coalesce(
        nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
        'Uncategorized'
      ) as category,
      nullif(trim(i.size), '') as size,
      l.list_date,
      l.list_price,
      sa.sale_date,
      sa.sale_price
    from public.inventory_items i
    left join lateral (
      select listed_at as list_date, listing_price as list_price
      from public.listings
      where listings.inventory_item_id = i.id
      order by listings.listed_at desc nulls last, listings.created_at desc
      limit 1
    ) l on true
    left join lateral (
      select coalesce(sold_at, sale_date) as sale_date, sale_price
      from public.sales
      where sales.inventory_item_id = i.id
      order by coalesce(sales.sold_at, sales.sale_date) desc nulls last,
        sales.created_at desc
      limit 1
    ) sa on true
    -- ── US-2235 AC1: THE FILTERS GO HERE, AND ONLY HERE ────────────────────
    --
    -- Applying them to `base` is what makes this safe, and it is worth being
    -- explicit about why, because filtering is exactly how a k-anonymity
    -- guarantee gets broken. Every aggregate below already carries its own
    -- `sellers >= min_sellers` guard. Narrowing `base` means each of those
    -- guards re-evaluates against the FILTERED cohort — so an attacker who
    -- filters down to one seller gets nulls everywhere, not that seller's
    -- numbers. No new guard is needed, and none may be added downstream: a
    -- filter applied in the OUTPUT projection instead would leave every guard
    -- counting the unfiltered population and would hand back a cohort of one.
    --
    -- The caller's own "you" section is unaffected by that reasoning — it is
    -- their data — but it IS filtered too, which is the honest behaviour:
    -- "your sell-through on Nike" should mean Nike.
    where (p_brand is null
        or lower(coalesce(nullif(trim(i.brand), ''), 'No brand')) = lower(trim(p_brand)))
      and (p_category is null
        or lower(coalesce(
             nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
             'Uncategorized'
           )) = lower(trim(p_category)))
      -- An item with NO size cannot match a size filter. Treating null as a
      -- match would silently widen the cohort past what the seller asked for.
      and (p_size is null
        or lower(coalesce(nullif(trim(i.size), ''), '')) = lower(trim(p_size)))
      -- Same for price: an unlisted item has no list price, so it is outside
      -- any band rather than inside every one.
      and (p_price_min is null or (l.list_price is not null and l.list_price >= p_price_min))
      and (p_price_max is null or (l.list_price is not null and l.list_price <= p_price_max))
  ),
  hits as (
    -- Apply the period window once; an item is "listed"/"sold" in-window the
    -- same way flipdesk_sell_through defines it (null period = all time).
    select
      user_id,
      brand,
      category,
      size,
      list_date,
      list_price,
      sale_date,
      sale_price,
      (list_date is not null
        and (p_period_start is null or list_date::date >= p_period_start)) as listed_hit,
      (sale_date is not null
        and (p_period_start is null or sale_date::date >= p_period_start)) as sold_hit
    from base
  ),
  -- In-window sold items with the two derived per-item facts the deep-dives need:
  -- days listed→sold and sale/list price realization. percentile_cont ignores the
  -- NULLs from items missing a list date / list price, so no extra filtering.
  sold_items as (
    select
      user_id,
      brand,
      category,
      sale_price,
      list_price,
      case when list_date is not null and sale_date::date >= list_date::date
        then (sale_date::date - list_date::date) end as days_to_sell,
      case when list_price is not null and list_price > 0 and sale_price is not null
        then sale_price::numeric / list_price end as realization
    from hits
    where sold_hit
  ),
  -- ── Brand deep-dive (k-anonymous) ─────────────────────────────────────────
  brand_agg as (
    select
      brand,
      count(distinct user_id) filter (where listed_hit or sold_hit) as sellers,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(sale_price) filter (where sold_hit and sale_price is not null) as avg_sale_price
    from hits
    where brand <> 'No brand'
    group by brand
    having count(distinct user_id) filter (where listed_hit or sold_hit) >= (select min_sellers from cfg)
       and count(*) filter (where listed_hit) >= (select min_sellers from cfg)
  ),
  brand_sold as (
    select
      brand,
      count(distinct user_id) as sellers,
      percentile_cont(0.5) within group (order by days_to_sell) as median_days,
      percentile_cont(0.5) within group (order by realization)  as median_real
    from sold_items
    where brand <> 'No brand'
    group by brand
  ),
  -- ── Category deep-dive (k-anonymous), same shape as brands ────────────────
  category_agg as (
    select
      category,
      count(distinct user_id) filter (where listed_hit or sold_hit) as sellers,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(sale_price) filter (where sold_hit and sale_price is not null) as avg_sale_price
    from hits
    where category <> 'Uncategorized'
    group by category
    having count(distinct user_id) filter (where listed_hit or sold_hit) >= (select min_sellers from cfg)
       and count(*) filter (where listed_hit) >= (select min_sellers from cfg)
  ),
  category_sold as (
    select
      category,
      count(distinct user_id) as sellers,
      percentile_cont(0.5) within group (order by days_to_sell) as median_days,
      percentile_cont(0.5) within group (order by realization)  as median_real
    from sold_items
    where category <> 'Uncategorized'
    group by category
  ),
  -- ── Trending categories: last 30d vs prior 30d (k-anonymous) ──────────────
  cat_trend as (
    select
      category,
      count(distinct user_id)
        filter (where sale_date is not null
          and sale_date::date >= current_date - 60) as sellers,
      count(*) filter (where sale_date is not null
        and sale_date::date >= current_date - 30) as sold_recent,
      count(*) filter (where sale_date is not null
        and sale_date::date >= current_date - 60
        and sale_date::date <  current_date - 30) as sold_prev
    from hits
    where category <> 'Uncategorized'
    group by category
    having count(distinct user_id)
      filter (where sale_date is not null
        and sale_date::date >= current_date - 60) >= (select min_sellers from cfg)
  ),
  -- ── Price realization, community-wide (k-anonymous) ───────────────────────
  realization_stats as (
    select
      count(distinct user_id) as sellers,
      count(*) filter (where realization is not null) as sales,
      percentile_cont(0.25) within group (order by realization)  as p25,
      percentile_cont(0.5)  within group (order by realization)  as p50,
      percentile_cont(0.75) within group (order by realization)  as p75,
      percentile_cont(0.5)  within group (order by sale_price)   as median_sale,
      percentile_cont(0.5)  within group (order by list_price)   as median_list
    from sold_items
    where realization is not null
  ),
  -- ── Time-to-sell percentiles, community-wide (k-anonymous) ────────────────
  tts_stats as (
    select
      count(distinct user_id) as sellers,
      count(*) filter (where days_to_sell is not null) as sales,
      percentile_cont(0.25) within group (order by days_to_sell) as p25,
      percentile_cont(0.5)  within group (order by days_to_sell) as p50,
      percentile_cont(0.75) within group (order by days_to_sell) as p75,
      percentile_cont(0.9)  within group (order by days_to_sell) as p90
    from sold_items
    where days_to_sell is not null
  ),
  -- ── Trend series: fixed windows + 12-month monthly buckets ────────────────
  -- These define their OWN time windows (sale_date based), so — like trending
  -- categories — they ignore p_period_start and always reflect the live trend.
  all_sales as (
    select user_id, sale_date::date as sd, sale_price
    from base
    where sale_date is not null
  ),
  win as (
    select
      count(distinct user_id) filter (where sd >= current_date - 30)  as s30_sellers,
      count(*) filter (where sd >= current_date - 30)                 as s30_sold,
      sum(sale_price) filter (where sd >= current_date - 30)          as s30_gmv,
      count(distinct user_id) filter (where sd >= current_date - 90)  as s90_sellers,
      count(*) filter (where sd >= current_date - 90)                 as s90_sold,
      sum(sale_price) filter (where sd >= current_date - 90)          as s90_gmv,
      count(distinct user_id) filter (where sd >= current_date - 365) as s365_sellers,
      count(*) filter (where sd >= current_date - 365)                as s365_sold,
      sum(sale_price) filter (where sd >= current_date - 365)         as s365_gmv
    from all_sales
  ),
  months as (
    select
      to_char(g, 'YYYY-MM') as month,
      g as month_start
    from generate_series(
      date_trunc('month', current_date::timestamp) - interval '11 months',
      date_trunc('month', current_date::timestamp),
      interval '1 month'
    ) g
  ),
  monthly as (
    select
      m.month,
      m.month_start,
      count(distinct s.user_id) as sellers,
      count(s.*) as sold,
      coalesce(sum(s.sale_price), 0) as gmv
    from months m
    left join all_sales s on date_trunc('month', s.sd::timestamp) = m.month_start
    group by m.month, m.month_start
  ),
  -- ── Seller-level sell-through for the you-vs-peers comparison ──────────────
  -- Require a minimum listing volume so a 1-item fluke is not a "rate".
  seller_rates as (
    select
      user_id,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      (count(*) filter (where sold_hit))::numeric
        / nullif(count(*) filter (where listed_hit), 0) as st
    from hits
    group by user_id
    having count(*) filter (where listed_hit) >= 3
  ),
  caller as (
    select listed, sold, st from seller_rates where user_id = auth.uid()
  ),
  -- The caller's raw counts, independent of the >= 3 listed floor, so they
  -- always see their own numbers even with thin inventory.
  caller_raw as (
    select
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold
    from hits
    where user_id = auth.uid()
  ),
  -- The caller's own time-to-sell / realization medians — always shown (own data).
  caller_sold as (
    select
      percentile_cont(0.5) within group (order by days_to_sell) as median_days,
      percentile_cont(0.5) within group (order by realization)  as median_real,
      count(*) filter (where days_to_sell is not null) as with_days,
      count(*) filter (where realization is not null)  as with_real
    from sold_items
    where user_id = auth.uid()
  ),
  peers as (
    select st from seller_rates where user_id <> auth.uid() and st is not null
  ),
  peer_stats as (
    select
      count(*) as n,
      percentile_cont(0.5) within group (order by st) as median
    from peers
  ),
  -- ── US-2235 AC2: how many sellers are actually behind these numbers ───────
  --
  -- The page previously showed medians and percentiles with no sense of scale,
  -- so "the community median" read the same whether it came from 6 sellers or
  -- 600. That is the difference between a curiosity and a number worth sourcing
  -- against, and only one of the two deserves the confidence the UI projected.
  --
  -- Two counts, because they answer different questions: `cohort` is who is in
  -- the current (possibly filtered) view, `total` is the whole platform. A
  -- seller narrowing to one brand needs to see BOTH — "12 of 480 sellers" says
  -- what a bare 12 cannot.
  --
  -- Both pass the same k-anonymity floor. A cohort count below the floor is
  -- returned as null, not as the number: every aggregate is already nulled at
  -- that point, and publishing "3 sellers" alongside them would leak the one
  -- fact the nulls exist to withhold.
  coverage_stats as (
    select
      (select count(distinct user_id) from hits) as cohort_sellers,
      (select count(distinct user_id) from public.inventory_items) as total_sellers
  )
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'minSellers', (select min_sellers from cfg),
      'periodStart', p_period_start,
      'generatedAt', now(),
      -- Echoed back so the client renders what the SERVER actually applied
      -- rather than what it believes it asked for. The two diverge the moment a
      -- filter is added on one side only, and a banner claiming a filter that
      -- never reached the query is worse than no banner.
      'filters', jsonb_build_object(
        'brand', nullif(trim(coalesce(p_brand, '')), ''),
        'category', nullif(trim(coalesce(p_category, '')), ''),
        'size', nullif(trim(coalesce(p_size, '')), ''),
        'priceMin', p_price_min,
        'priceMax', p_price_max
      ),
      'coverage', (
        select jsonb_build_object(
          'cohortSellers', case when cv.cohort_sellers >= (select min_sellers from cfg)
            then cv.cohort_sellers else null end,
          'totalSellers', case when cv.total_sellers >= (select min_sellers from cfg)
            then cv.total_sellers else null end,
          -- So the UI can say "too few to show" without inferring it from a
          -- null it cannot distinguish from "nobody has sold anything yet".
          'belowFloor', cv.cohort_sellers < (select min_sellers from cfg)
        )
        from coverage_stats cv
      )
    ),
    'topBrands', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'brand', ba.brand,
          'sellers', ba.sellers,
          'listed', ba.listed,
          'sold', ba.sold,
          'sellThrough', case when ba.listed > 0 then ba.sold::numeric / ba.listed else null end,
          'avgSalePrice', round(ba.avg_sale_price::numeric, 2),
          -- Per-brand derived medians only when the brand's SOLD cohort itself is
          -- k-anonymous (distinct sellers who sold it >= floor).
          'medianRealization', case when bs.sellers >= (select min_sellers from cfg)
            then round(bs.median_real::numeric, 4) else null end,
          'medianDaysToSell', case when bs.sellers >= (select min_sellers from cfg)
            then round(bs.median_days::numeric, 1) else null end
        )
        order by case when ba.listed > 0 then ba.sold::numeric / ba.listed else 0 end desc,
          ba.sold desc
      )
      from brand_agg ba
      left join brand_sold bs on bs.brand = ba.brand
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'category', ca.category,
          'sellers', ca.sellers,
          'listed', ca.listed,
          'sold', ca.sold,
          'sellThrough', case when ca.listed > 0 then ca.sold::numeric / ca.listed else null end,
          'avgSalePrice', round(ca.avg_sale_price::numeric, 2),
          'medianRealization', case when cs.sellers >= (select min_sellers from cfg)
            then round(cs.median_real::numeric, 4) else null end,
          'medianDaysToSell', case when cs.sellers >= (select min_sellers from cfg)
            then round(cs.median_days::numeric, 1) else null end
        )
        order by case when ca.listed > 0 then ca.sold::numeric / ca.listed else 0 end desc,
          ca.sold desc
      )
      from category_agg ca
      left join category_sold cs on cs.category = ca.category
    ), '[]'::jsonb),
    'trendingCategories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'category', category,
          'sellers', sellers,
          'soldRecent', sold_recent,
          'soldPrevious', sold_prev,
          'growth', case when sold_prev > 0
            then (sold_recent - sold_prev)::numeric / sold_prev else null end
        )
        order by sold_recent desc, sold_prev desc
      )
      from cat_trend
    ), '[]'::jsonb),
    -- Overall price realization (sale vs list). Null until the cohort is k-anon.
    'priceRealization', (
      select case when rs.sellers >= (select min_sellers from cfg) then jsonb_build_object(
        'sellers', rs.sellers,
        'sales', rs.sales,
        'medianRatio', round(rs.p50::numeric, 4),
        'p25Ratio', round(rs.p25::numeric, 4),
        'p75Ratio', round(rs.p75::numeric, 4),
        'medianSalePrice', round(rs.median_sale::numeric, 2),
        'medianListPrice', round(rs.median_list::numeric, 2)
      ) else null end
      from realization_stats rs
    ),
    -- Time-to-sell distribution (days). Null until the cohort is k-anon.
    'timeToSell', (
      select case when ts.sellers >= (select min_sellers from cfg) then jsonb_build_object(
        'sellers', ts.sellers,
        'sales', ts.sales,
        'p25', round(ts.p25::numeric, 1),
        'p50', round(ts.p50::numeric, 1),
        'p75', round(ts.p75::numeric, 1),
        'p90', round(ts.p90::numeric, 1)
      ) else null end
      from tts_stats ts
    ),
    -- Trend windows + monthly series. Each window / month with too few sellers is
    -- nulled out (kept in the series so the chart shows a gap, never a count < floor).
    'trends', jsonb_build_object(
      'windows', (
        select jsonb_build_object(
          'd30', case when w.s30_sellers >= (select min_sellers from cfg)
            then jsonb_build_object('sellers', w.s30_sellers, 'sold', w.s30_sold,
              'gmv', round(coalesce(w.s30_gmv, 0)::numeric, 2)) else null end,
          'd90', case when w.s90_sellers >= (select min_sellers from cfg)
            then jsonb_build_object('sellers', w.s90_sellers, 'sold', w.s90_sold,
              'gmv', round(coalesce(w.s90_gmv, 0)::numeric, 2)) else null end,
          'd365', case when w.s365_sellers >= (select min_sellers from cfg)
            then jsonb_build_object('sellers', w.s365_sellers, 'sold', w.s365_sold,
              'gmv', round(coalesce(w.s365_gmv, 0)::numeric, 2)) else null end
        )
        from win w
      ),
      'monthly', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'month', mo.month,
            'sellers', case when mo.sellers >= (select min_sellers from cfg) then mo.sellers else null end,
            'sold', case when mo.sellers >= (select min_sellers from cfg) then mo.sold else null end,
            'gmv', case when mo.sellers >= (select min_sellers from cfg) then round(mo.gmv::numeric, 2) else null end
          )
          order by mo.month_start
        )
        from monthly mo
      ), '[]'::jsonb)
    ),
    'you', jsonb_build_object(
      'listed', (select listed from caller_raw),
      'sold', (select sold from caller_raw),
      'sellThrough', (
        select case when listed > 0 then sold::numeric / listed else null end
        from caller_raw
      ),
      'medianDaysToSell', (
        select case when with_days > 0 then round(median_days::numeric, 1) else null end
        from caller_sold
      ),
      'medianRealization', (
        select case when with_real > 0 then round(median_real::numeric, 4) else null end
        from caller_sold
      ),
      -- Peer comparison is itself k-anonymous: shown only when >= floor peers have
      -- a rate, and exposes only cohort statistics (median, the caller's percentile
      -- among peers) — never an individual peer's value.
      'peerComparison', (
        select case when ps.n >= (select min_sellers from cfg) then jsonb_build_object(
          'peerCount', ps.n,
          'peerMedianSellThrough', round(ps.median::numeric, 4),
          'yourSellThrough', (select st from caller),
          'percentile', case
            when (select st from caller) is not null then (
              select round(avg(case when p.st <= (select st from caller)
                then 1.0 else 0.0 end)::numeric, 2)
              from peers p
            )
            else null
          end
        ) else null end
        from peer_stats ps
      )
    )
  );
$$;

-- authenticated only — there is no reason for anon to pull community aggregates,
-- and the function relies on auth.uid() to scope the "you" section.
grant execute on function
  public.community_benchmarks(date, text, text, text, numeric, numeric)
  to authenticated;
grant execute on function
  public.community_benchmarks(date, text, text, text, numeric, numeric)
  to service_role;

COMMIT;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00569') on conflict do nothing;
