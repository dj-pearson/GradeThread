-- US-602: Reseller benchmarking / community insights.
--
-- Resellers want anonymized market signal — what to source and how they stack
-- up — without any single seller's numbers ever leaking. Every other analytics
-- RPC (finances_dashboard, flipdesk_sell_through, flipdesk_grading_roi) is
-- SECURITY INVOKER and scoped to the caller's own tenant via RLS. This one is
-- DELIBERATELY different: it aggregates across the WHOLE platform, so it is
-- SECURITY DEFINER (bypasses RLS) and earns that privilege by returning ONLY:
--   1. cohort aggregates that pass a k-anonymity threshold (>= MIN_SELLERS=5
--      distinct sellers contributing to every row that is returned), and
--   2. the CALLER'S OWN numbers (auth.uid()), which are their data anyway.
-- No per-seller row, id, or raw value for anyone else ever leaves the function.
-- search_path is pinned and EXECUTE is granted to authenticated only.
--
-- The base CTE re-derives the same per-item facts items_full exposes (latest
-- listing's listed_at, latest sale's sale_date/sale_price) but over EVERY user's
-- inventory rather than just the caller's — that is the whole point, and the
-- reason it cannot reuse the security_invoker items_full view.

BEGIN;

create or replace function public.community_benchmarks(
  p_period_start date default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    -- One row per inventory item, platform-wide, with its latest listing/sale.
    select
      i.user_id,
      coalesce(nullif(trim(i.brand), ''), 'No brand') as brand,
      coalesce(
        nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
        'Uncategorized'
      ) as category,
      l.list_date,
      sa.sale_date,
      sa.sale_price
    from public.inventory_items i
    left join lateral (
      select listed_at as list_date
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
  ),
  hits as (
    -- Apply the period window once; an item is "listed"/"sold" in-window the
    -- same way flipdesk_sell_through defines it (null period = all time).
    select
      user_id,
      brand,
      category,
      sale_price,
      sale_date,
      (list_date is not null
        and (p_period_start is null or list_date::date >= p_period_start)) as listed_hit,
      (sale_date is not null
        and (p_period_start is null or sale_date::date >= p_period_start)) as sold_hit
    from base
  ),
  -- ── Top brands by sell-through (k-anonymous) ──────────────────────────────
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
    -- k-anonymity: only surface a brand once >= 5 distinct sellers traded it,
    -- and only when there is real listing volume behind the sell-through.
    having count(distinct user_id) filter (where listed_hit or sold_hit) >= 5
       and count(*) filter (where listed_hit) >= 5
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
        and sale_date::date >= current_date - 60) >= 5
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
  peers as (
    select st from seller_rates where user_id <> auth.uid() and st is not null
  ),
  peer_stats as (
    select
      count(*) as n,
      percentile_cont(0.5) within group (order by st) as median
    from peers
  )
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'minSellers', 5,
      'periodStart', p_period_start,
      'generatedAt', now()
    ),
    'topBrands', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'brand', brand,
          'sellers', sellers,
          'listed', listed,
          'sold', sold,
          'sellThrough', case when listed > 0 then sold::numeric / listed else null end,
          'avgSalePrice', round(avg_sale_price::numeric, 2)
        )
        order by case when listed > 0 then sold::numeric / listed else 0 end desc,
          sold desc
      )
      from brand_agg
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
    'you', jsonb_build_object(
      'listed', (select listed from caller_raw),
      'sold', (select sold from caller_raw),
      'sellThrough', (
        select case when listed > 0 then sold::numeric / listed else null end
        from caller_raw
      ),
      -- Peer comparison is itself k-anonymous: shown only when >= 5 peers have a
      -- rate, and exposes only cohort statistics (median, the caller's percentile
      -- among peers) — never an individual peer's value.
      'peerComparison', (
        select case when ps.n >= 5 then jsonb_build_object(
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
grant execute on function public.community_benchmarks(date) to authenticated;
grant execute on function public.community_benchmarks(date) to service_role;

COMMIT;
