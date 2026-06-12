-- US-403: Server-side Finances aggregation.
--
-- The Finances page previously pulled four unbounded `select('*')` result sets
-- (inventory_items, sales, shipments, listings) into the browser and aggregated
-- the entire account in JS. For a reseller with a large history that meant
-- multi-megabyte payloads and main-thread aggregation that scaled linearly with
-- account size.
--
-- This function does ALL of that aggregation in Postgres and returns a single
-- compact JSON document. The period filter is pushed into the query (no
-- client-side date filtering), and every metric/series is computed server-side.
-- Row-level drill-down lists (cash-flow transactions, profit rows, grade
-- scatter points, stale/slow item lists) are capped to bound the payload — the
-- aggregates above them are always computed over the FULL matching set, and a
-- companion `*_total` count tells the UI when a list was truncated.
--
-- Consistency note: unlike the old per-component JS (which inconsistently
-- filtered sale status / period), every sales-based metric here is computed over
-- COMPLETED sales within the selected period. 'completed' is the canonical
-- revenue definition already used by the summary cards (cancelled/refunded
-- orders are not revenue); applying it uniformly aligns the charts with the
-- summary and honours the period filter everywhere.
--
-- SECURITY INVOKER: the function runs as the caller, so the existing RLS
-- policies on every table (owner + workspace member visibility) apply exactly as
-- they did when the page queried the tables directly. No new data is exposed.

create or replace function public.finances_dashboard(
  p_period_start timestamptz default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with
-- One shipment per sale (latest wins), mirroring the JS Map keyed by sale_id.
ship as (
  select distinct on (sale_id)
    sale_id,
    (shipping_cost + label_cost) as ship_total,
    ship_date
  from public.shipments
  order by sale_id, created_at desc
),
-- Highest listing price per item (profit table "Listed Price").
max_listing as (
  select inventory_item_id, max(listing_price) as listing_price
  from public.listings
  group by inventory_item_id
),
-- Latest listing price per item (inventory market value), newest first.
latest_listing as (
  select distinct on (inventory_item_id)
    inventory_item_id, listing_price
  from public.listings
  where listing_price is not null
  order by inventory_item_id, coalesce(listed_at, created_at) desc
),
-- Earliest listing date per item (time-on-market start).
earliest_listing as (
  select inventory_item_id, min(listed_at) as listed_at
  from public.listings
  group by inventory_item_id
),
-- All sold item ids (any status/period) — used to exclude already-sold items
-- from the slow-moving list, matching the JS soldItemIds set.
sold_items as (
  select distinct inventory_item_id from public.sales
),
-- Completed sales in the selected period, joined to their item + shipment +
-- listing rollups, with all per-sale derived money columns precomputed.
base as (
  select
    s.id,
    s.inventory_item_id,
    s.sale_date,
    s.sale_price,
    s.platform_fees,
    i.acquired_price,
    i.acquired_date,
    i.title,
    i.grade_value,
    i.garment_type,
    sh.ship_total,
    sh.ship_date,
    ml.listing_price as max_listing_price,
    el.listed_at     as earliest_listed_at,
    coalesce(i.acquired_price, 0) as cost_basis,
    coalesce(nullif(trim(i.brand), ''), 'Unknown') as brand_key,
    coalesce(initcap(i.garment_category::text), 'Unknown') as cat_title,
    coalesce(
      nullif(trim(src.name), ''),
      nullif(trim(i.acquired_source), ''),
      'Unknown'
    ) as source_key,
    -- computePnl(): net = (sale_price + shipping_collected)
    --   - (platform_fees + payment_processing_fees)
    --   - (shipping_cost + grading_cost + other_costs) - cost_basis
    (s.sale_price + s.shipping_collected) as pnl_revenue,
    (s.platform_fees + s.payment_processing_fees) as pnl_fees,
    (s.shipping_cost + s.grading_cost + s.other_costs) as pnl_costs,
    (
      (s.sale_price + s.shipping_collected)
      - (s.platform_fees + s.payment_processing_fees)
      - (s.shipping_cost + s.grading_cost + s.other_costs)
      - coalesce(i.acquired_price, 0)
    ) as pnl_net,
    -- Legacy shipments table extra: only when the sale row carries no shipping.
    case
      when sh.ship_total is not null and coalesce(s.shipping_cost, 0) = 0
      then sh.ship_total else 0
    end as ship_extra,
    -- financial-charts / profit-table cost basis: acquisition + platform fees
    -- + shipment total (always folded in here, matching those components).
    (s.sale_price
      - (coalesce(i.acquired_price, 0) + s.platform_fees + coalesce(sh.ship_total, 0))
    ) as chart_profit,
    (coalesce(i.acquired_price, 0) + s.platform_fees + coalesce(sh.ship_total, 0)) as chart_cost,
    -- Days to sell (acquired -> sale), floored, non-negative only.
    case
      when i.acquired_date is not null
      then floor(extract(epoch from (s.sale_date - i.acquired_date::timestamptz)) / 86400)
    end as days_to_sell,
    -- Days on market (earliest listing -> sale), floored, non-negative only.
    case
      when el.listed_at is not null
      then floor(extract(epoch from (s.sale_date - el.listed_at::timestamptz)) / 86400)
    end as days_on_market,
    -- Grade tier (worst -> best by floor), mirroring tierFor().
    case
      when i.grade_value >= 9.5 then 'NWT'
      when i.grade_value >= 8.5 then 'NWOT'
      when i.grade_value >= 7.5 then 'Excellent'
      when i.grade_value >= 6.5 then 'Very Good'
      when i.grade_value >= 5.5 then 'Good'
      when i.grade_value >= 4.5 then 'Fair'
      else 'Poor'
    end as grade_tier
  from public.sales s
  left join public.inventory_items i on i.id = s.inventory_item_id
  left join ship sh on sh.sale_id = s.id
  left join max_listing ml on ml.inventory_item_id = s.inventory_item_id
  left join earliest_listing el on el.inventory_item_id = s.inventory_item_id
  left join public.sources src on src.id = i.source_id
  where s.status = 'completed'
    and (p_period_start is null or s.sale_date >= p_period_start)
),
-- Summary aggregates (one row).
summ as (
  select
    coalesce(sum(pnl_revenue), 0) as rev,
    coalesce(sum(pnl_fees), 0)    as fees,
    coalesce(sum(pnl_costs), 0)   as sale_costs,
    coalesce(sum(cost_basis), 0)  as acq,
    coalesce(sum(ship_extra), 0)  as ship_extra,
    count(*)                      as items_sold,
    coalesce(sum(days_to_sell) filter (where days_to_sell >= 0), 0) as sum_days,
    count(*) filter (where days_to_sell >= 0)                       as days_cnt
  from base
),
-- Inventory market value: active (unsold) items at latest listing price,
-- falling back to target price.
inv as (
  select coalesce(sum(coalesce(ll.listing_price, i.target_price, 0)), 0) as inventory_value
  from public.inventory_items i
  left join latest_listing ll on ll.inventory_item_id = i.id
  where i.status in (
    'sourced','acquired','cataloged','measured','photographed',
    'grading','graded','comped','drafted','listed'
  )
),
-- Daily revenue/profit series for the time chart (client re-buckets weekly/monthly).
ts_daily as (
  select
    to_char(sale_date, 'YYYY-MM-DD') as d,
    round(sum(sale_price)::numeric, 2)   as revenue,
    round(sum(chart_profit)::numeric, 2) as profit
  from base
  group by 1
  order by 1
),
-- Cash-flow daily inflow/outflow (sales + fees on sale_date, shipping on
-- ship_date, acquisitions on acquired_date) within the period.
cf_txn as (
  -- sale inflow
  select sale_date::date as d, 'inflow' as kind, sale_price as amount,
         'Sale' as category, coalesce(title, 'Item sale') as description
  from base
  union all
  -- platform fee outflow
  select sale_date::date, 'outflow', platform_fees,
         'Platform Fees', 'Fees for ' || coalesce(title, 'item sale')
  from base where platform_fees > 0
  union all
  -- shipping outflow (on ship date)
  select ship_date::date, 'outflow', ship_total,
         'Shipping', 'Shipping for ' || coalesce(title, 'item')
  from base where ship_total is not null and ship_total > 0 and ship_date is not null
  union all
  -- acquisition outflow (item acquired in-period)
  select i.acquired_date::date, 'outflow', i.acquired_price,
         'Acquisition', i.title
  from public.inventory_items i
  where i.acquired_price is not null and i.acquired_price > 0
    and i.acquired_date is not null
    and (p_period_start is null or i.acquired_date::timestamptz >= p_period_start)
),
cf_daily as (
  select
    to_char(d, 'YYYY-MM-DD') as d,
    round(coalesce(sum(amount) filter (where kind = 'inflow'), 0)::numeric, 2)  as inflow,
    round(coalesce(sum(amount) filter (where kind = 'outflow'), 0)::numeric, 2) as outflow
  from cf_txn
  group by 1
  order by 1
),
-- ROI item-level rows (cost basis > 0) for best/worst performer tables.
item_roi as (
  select
    id,
    title,
    nullif(
      concat_ws(' · ',
        nullif(brand_key, 'Unknown'),
        nullif(cat_title, 'Unknown')
      ), ''
    ) as detail,
    round(pnl_net::numeric, 2) as profit,
    round(cost_basis::numeric, 2) as cost_basis,
    round(((pnl_net / cost_basis) * 100)::numeric, 2) as roi_pct
  from base
  where cost_basis > 0
),
roi_best as (
  select * from item_roi order by roi_pct desc, id limit 10
),
roi_worst as (
  select * from item_roi
  where id not in (select id from roi_best)
  order by roi_pct asc, id limit 10
),
-- Grade vs price scatter points (capped — aggregates below use the full set).
gp_points as (
  select grade_value as grade, sale_price as price,
         round(pnl_net::numeric, 2) as profit,
         coalesce(initcap(garment_type::text), 'Uncategorized') as category,
         sale_date
  from base
  where grade_value is not null
),
-- Slow-moving inventory (listed/graded, never sold, listed 30+ days ago).
slow as (
  select
    i.id, i.title, i.brand, i.garment_type, i.status,
    floor(extract(epoch from (now() - el.listed_at::timestamptz)) / 86400)::int as days_listed
  from public.inventory_items i
  join earliest_listing el on el.inventory_item_id = i.id
  where i.status in ('listed', 'graded')
    and i.id not in (select inventory_item_id from sold_items)
    and floor(extract(epoch from (now() - el.listed_at::timestamptz)) / 86400) >= 30
),
-- Inventory aging brackets (unsold items by hold age).
aging_items as (
  select
    i.id, i.title, i.status,
    coalesce(i.acquired_price, 0) as value,
    floor(
      extract(epoch from (now() - coalesce(i.acquired_date, i.created_at)::timestamptz)) / 86400
    )::int as age
  from public.inventory_items i
  where i.status not in ('sold', 'shipped', 'completed')
),
aging_bucketed as (
  select *,
    case
      when age <= 14 then '0-14 days'
      when age <= 30 then '15-30 days'
      when age <= 60 then '31-60 days'
      else '60+ days'
    end as bracket
  from aging_items
)
select jsonb_build_object(
  'summary', (
    select jsonb_build_object(
      'total_revenue',       round(summ.rev::numeric, 2),
      'total_costs',         round((summ.fees + summ.sale_costs + summ.acq + summ.ship_extra)::numeric, 2),
      'net_profit',          round((summ.rev - (summ.fees + summ.sale_costs + summ.acq + summ.ship_extra))::numeric, 2),
      'profit_margin', case when summ.rev > 0
        then round((((summ.rev - (summ.fees + summ.sale_costs + summ.acq + summ.ship_extra)) / summ.rev) * 100)::numeric, 2)
        else 0 end,
      'items_sold',          summ.items_sold,
      'avg_profit_per_item', case when summ.items_sold > 0
        then round(((summ.rev - (summ.fees + summ.sale_costs + summ.acq + summ.ship_extra)) / summ.items_sold)::numeric, 2)
        else 0 end,
      'avg_days_to_sell', case when summ.days_cnt > 0
        then round(summ.sum_days::numeric / summ.days_cnt)::int else 0 end,
      'inventory_value',     round((select inventory_value from inv)::numeric, 2)
    ) from summ
  ),

  -- financial-charts
  'time_series', coalesce((
    select jsonb_agg(jsonb_build_object('d', d, 'revenue', revenue, 'profit', profit) order by d)
    from ts_daily
  ), '[]'::jsonb),
  'cost_breakdown', (
    select jsonb_build_object(
      'acquisition',   round(coalesce(sum(cost_basis), 0)::numeric, 2),
      'shipping',      round(coalesce(sum(coalesce(ship_total, 0)), 0)::numeric, 2),
      'platform_fees', round(coalesce(sum(platform_fees), 0)::numeric, 2),
      'grading',       0
    ) from base
  ),
  'top_brands', coalesce((
    select jsonb_agg(jsonb_build_object('name', name, 'value', value) order by value desc)
    from (
      select brand_key as name, round(sum(chart_profit)::numeric, 2) as value
      from base group by brand_key order by sum(chart_profit) desc limit 5
    ) b
  ), '[]'::jsonb),
  'top_categories', coalesce((
    select jsonb_agg(jsonb_build_object('name', name, 'value', value) order by value desc)
    from (
      select cat_title as name, round(sum(chart_profit)::numeric, 2) as value
      from base group by cat_title order by sum(chart_profit) desc limit 5
    ) c
  ), '[]'::jsonb),

  -- roi-analytics
  'roi_by_brand', coalesce((
    select jsonb_agg(g order by (g->>'total_profit')::numeric desc) from (
      select jsonb_build_object(
        'name', brand_key, 'items_sold', count(*),
        'total_profit', round(sum(pnl_net)::numeric, 2),
        'total_cost_basis', round(sum(cost_basis)::numeric, 2)
      ) as g
      from base group by brand_key
    ) x
  ), '[]'::jsonb),
  'roi_by_category', coalesce((
    select jsonb_agg(g order by (g->>'total_profit')::numeric desc) from (
      select jsonb_build_object(
        'name', cat_title, 'items_sold', count(*),
        'total_profit', round(sum(pnl_net)::numeric, 2),
        'total_cost_basis', round(sum(cost_basis)::numeric, 2)
      ) as g
      from base group by cat_title
    ) x
  ), '[]'::jsonb),
  'roi_by_source', coalesce((
    select jsonb_agg(g order by (g->>'total_profit')::numeric desc) from (
      select jsonb_build_object(
        'name', source_key, 'items_sold', count(*),
        'total_profit', round(sum(pnl_net)::numeric, 2),
        'total_cost_basis', round(sum(cost_basis)::numeric, 2)
      ) as g
      from base group by source_key
    ) x
  ), '[]'::jsonb),
  'roi_best_items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'detail', coalesce(detail, ''),
      'profit', profit, 'cost_basis', cost_basis, 'roi_pct', roi_pct
    ) order by roi_pct desc) from roi_best
  ), '[]'::jsonb),
  'roi_worst_items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'detail', coalesce(detail, ''),
      'profit', profit, 'cost_basis', cost_basis, 'roi_pct', roi_pct
    ) order by roi_pct asc) from roi_worst
  ), '[]'::jsonb),

  -- inventory-aging
  'inventory_aging', (
    select jsonb_build_object(
      'total_count', count(*),
      'total_value', round(coalesce(sum(value), 0)::numeric, 2),
      'brackets', coalesce((
        select jsonb_agg(jsonb_build_object(
          'label', b.label, 'count', coalesce(bb.cnt, 0), 'value', round(coalesce(bb.val, 0)::numeric, 2)
        ) order by b.ord)
        from (values ('0-14 days', 1), ('15-30 days', 2), ('31-60 days', 3), ('60+ days', 4)) as b(label, ord)
        left join (
          select bracket, count(*) as cnt, sum(value) as val from aging_bucketed group by bracket
        ) bb on bb.bracket = b.label
      ), '[]'::jsonb)
    ) from aging_items
  ),
  'stale_items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'status', status, 'age', age,
      'acquired_price', round(value::numeric, 2)
    ) order by age desc)
    from (select * from aging_bucketed where bracket = '60+ days' order by age desc limit 100) s
  ), '[]'::jsonb),
  'stale_items_total', (select count(*) from aging_bucketed where bracket = '60+ days'),

  -- grade-price-correlation
  'grade_points', coalesce((
    select jsonb_agg(jsonb_build_object(
      'grade', grade, 'price', price, 'profit', profit, 'category', category
    ))
    from (select * from gp_points order by sale_date desc limit 2000) p
  ), '[]'::jsonb),
  'grade_points_total', (select count(*) from gp_points),
  'grade_tier_stats', coalesce((
    select jsonb_agg(jsonb_build_object(
      'label', grade_tier, 'count', cnt, 'avg_price', avg_price, 'avg_profit', avg_profit
    ) order by ord)
    from (
      select grade_tier, count(*) as cnt,
        round(avg(price)::numeric, 2) as avg_price,
        round(avg(profit)::numeric, 2) as avg_profit,
        min(case grade_tier
          when 'Poor' then 1 when 'Fair' then 2 when 'Good' then 3
          when 'Very Good' then 4 when 'Excellent' then 5
          when 'NWOT' then 6 when 'NWT' then 7 end) as ord
      from (select grade_tier, sale_price as price, pnl_net as profit from base where grade_value is not null) t
      group by grade_tier
    ) ts
  ), '[]'::jsonb),
  'grade_category_tier', coalesce((
    select jsonb_agg(jsonb_build_object(
      'category', category, 'tier', grade_tier, 'avg_price', avg_price
    ))
    from (
      select coalesce(initcap(garment_type::text), 'Uncategorized') as category,
        grade_tier, round(avg(sale_price)::numeric, 2) as avg_price
      from base where grade_value is not null
      group by 1, grade_tier
    ) ct
  ), '[]'::jsonb),

  -- time-on-market
  'tom_overall_avg', (
    select case when count(*) filter (where days_on_market >= 0) > 0
      then round(avg(days_on_market) filter (where days_on_market >= 0))::int else 0 end
    from base
  ),
  'tom_by_type', coalesce((
    select jsonb_agg(jsonb_build_object('name', name, 'avg_days', avg_days, 'count', cnt) order by avg_days desc)
    from (
      select coalesce(initcap(replace(replace(garment_type::text, '_', ' '), '-', ' ')), 'Unknown') as name,
        round(avg(days_on_market))::int as avg_days, count(*) as cnt
      from base where days_on_market >= 0
      group by 1
    ) t
  ), '[]'::jsonb),
  'tom_by_brand', coalesce((
    select jsonb_agg(jsonb_build_object('name', name, 'avg_days', avg_days, 'count', cnt) order by avg_days desc)
    from (
      select brand_key as name, round(avg(days_on_market))::int as avg_days, count(*) as cnt
      from base where days_on_market >= 0
      group by brand_key
    ) t
  ), '[]'::jsonb),
  'tom_distribution', coalesce((
    select jsonb_agg(jsonb_build_object('range', range, 'count', cnt) order by ord)
    from (
      select b.range, b.ord, count(dm.days_on_market) as cnt
      from (values ('0-7', 0, 7, 1), ('8-14', 8, 14, 2), ('15-30', 15, 30, 3),
                   ('31-60', 31, 60, 4), ('61-90', 61, 90, 5), ('90+', 91, 2147483647, 6)) as b(range, lo, hi, ord)
      left join (select days_on_market from base where days_on_market >= 0) dm
        on dm.days_on_market between b.lo and b.hi
      group by b.range, b.ord
    ) d
  ), '[]'::jsonb),
  'tom_slow_moving', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'brand', brand, 'garment_type', garment_type,
      'status', status, 'days_listed', days_listed
    ) order by days_listed desc)
    from (select * from slow order by days_listed desc limit 100) s
  ), '[]'::jsonb),
  'tom_slow_moving_total', (select count(*) from slow),
  'tom_has_sold_data', (select count(*) filter (where days_on_market >= 0) > 0 from base),

  -- cash-flow
  'cash_flow_daily', coalesce((
    select jsonb_agg(jsonb_build_object('d', d, 'inflow', inflow, 'outflow', outflow) order by d)
    from cf_daily
  ), '[]'::jsonb),
  'cash_flow_recent', coalesce((
    select jsonb_agg(jsonb_build_object(
      'date', to_char(d, 'YYYY-MM-DD'), 'type', kind, 'category', category,
      'description', description, 'amount', round(amount::numeric, 2)
    ) order by d)
    from (select * from cf_txn order by d desc limit 500) r
  ), '[]'::jsonb),
  'cash_flow_total', (select count(*) from cf_txn),

  -- profit-table
  'profit_rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'title', coalesce(title, 'Unknown Item'), 'brand', brand_key,
      'category', coalesce(initcap(garment_type::text), '—'),
      'acquired_price', round(cost_basis::numeric, 2),
      'listed_price', round(coalesce(max_listing_price, 0)::numeric, 2),
      'sale_price', round(sale_price::numeric, 2),
      'platform_fees', round(platform_fees::numeric, 2),
      'shipping_cost', round(coalesce(ship_total, 0)::numeric, 2),
      'net_profit', round(chart_profit::numeric, 2),
      'profit_margin', case when sale_price > 0 then round(((chart_profit / sale_price) * 100)::numeric, 2) else 0 end,
      'sale_date', to_char(sale_date, 'YYYY-MM-DD"T"HH24:MI:SSOF')
    ) order by sale_date desc)
    from (select * from base order by sale_date desc limit 1000) p
  ), '[]'::jsonb),
  'profit_rows_total', (select count(*) from base)
);
$$;

-- Companion export endpoint: returns the flat transaction ledger for a date
-- range (sales income, platform-fee / shipping / acquisition expenses), with
-- the range pushed into the query. Used by the "Export Financial Report"
-- CSV/PDF download so the export no longer pulls whole tables into the browser.
-- Like the page's old export, this includes sales of every status (it is a raw
-- ledger, not the revenue view).
create or replace function public.finances_export(
  p_start date,
  p_end   date
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with
ship as (
  select distinct on (sale_id)
    sale_id, (shipping_cost + label_cost) as ship_total, ship_date
  from public.shipments
  order by sale_id, created_at desc
),
txn as (
  -- acquisition expenses
  select i.acquired_date::date as d, 'expense' as type, 'acquisition' as category,
         i.acquired_price as amount, i.title as item_title, '' as platform
  from public.inventory_items i
  where i.acquired_price is not null and i.acquired_price > 0
    and i.acquired_date is not null
    and i.acquired_date::date between p_start and p_end
  union all
  -- sale income
  select s.sale_date::date, 'income', 'sale', s.sale_price,
         coalesce(i.title, 'Unknown Item'), coalesce(l.platform::text, '')
  from public.sales s
  left join public.inventory_items i on i.id = s.inventory_item_id
  left join public.listings l on l.id = s.listing_id
  where s.sale_date::date between p_start and p_end
  union all
  -- platform fee expenses
  select s.sale_date::date, 'expense', 'fee', s.platform_fees,
         coalesce(i.title, 'Unknown Item'), coalesce(l.platform::text, '')
  from public.sales s
  left join public.inventory_items i on i.id = s.inventory_item_id
  left join public.listings l on l.id = s.listing_id
  where s.sale_date::date between p_start and p_end
    and s.platform_fees > 0
  union all
  -- shipping expenses (on ship date, falling back to sale date)
  select coalesce(sh.ship_date, s.sale_date)::date, 'expense', 'shipping', sh.ship_total,
         coalesce(i.title, 'Unknown Item'), coalesce(l.platform::text, '')
  from public.sales s
  join ship sh on sh.sale_id = s.id
  left join public.inventory_items i on i.id = s.inventory_item_id
  left join public.listings l on l.id = s.listing_id
  where sh.ship_total > 0
    and coalesce(sh.ship_date, s.sale_date)::date between p_start and p_end
)
select coalesce(
  jsonb_agg(jsonb_build_object(
    'date', to_char(d, 'YYYY-MM-DD'),
    'type', type,
    'category', category,
    'amount', round(amount::numeric, 2),
    'itemTitle', item_title,
    'platform', platform
  ) order by d),
  '[]'::jsonb
)
from txn;
$$;

comment on function public.finances_export(date, date) is
  'US-403: flat transaction ledger (sales income + fee/shipping/acquisition '
  'expenses) for a date range, range pushed into the query. Powers the '
  'Finances CSV/PDF export without loading raw tables into the browser.';

grant execute on function public.finances_export(date, date) to authenticated;
grant execute on function public.finances_export(date, date) to service_role;

comment on function public.finances_dashboard(timestamptz) is
  'US-403: returns all Finances page aggregates (summary, charts, ROI, aging, '
  'grade/price, time-on-market, cash-flow, profit rows) as one compact JSON '
  'document, scoped to the caller via RLS. Row-level lists are capped; see '
  '*_total counts. p_period_start filters sales by sale_date (null = all time).';

grant execute on function public.finances_dashboard(timestamptz) to authenticated;
grant execute on function public.finances_dashboard(timestamptz) to service_role;
