-- US-858: Elevate Grading-ROI into a first-class proof view.
--
-- Two server-side changes, both following the bounded-aggregation pattern
-- established for the analytics surfaces in 00148 (SECURITY INVOKER over the
-- items_full security_invoker view, so the caller's RLS applies and no explicit
-- user_id scoping is needed). The client receives a single compact summary
-- object / a handful of bucket rows — payload is independent of inventory size,
-- so the view stays fast on large accounts.
--
-- 1. NEW flipdesk_grading_roi_summary(): the overall graded-vs-ungraded headline
--    (sell-through %, median days-to-sell, avg net profit per side, plus the
--    lifts). One row's worth of numbers, returned as a single jsonb object.
-- 2. flipdesk_grading_roi() gains medianDaysToSell per side so the per-bucket
--    breakdown table can show how much faster graded items sell.

BEGIN;

-- ── Overall headline: graded vs ungraded across the whole account ───────────
-- "listed" = item has a list_date; "sold" = item has a sale_date (a realized
-- sale). Sell-through, median days-to-sell, and avg net profit are all computed
-- over the same sold-by-sale_date set, mirroring flipdesk_sell_through() so the
-- two surfaces agree. `meaningful` matches accountGradingRollup() in
-- src/lib/flipdesk-analytics.ts: both sides need >= 5 (MIN_BUCKET_SIZE) sales.
create or replace function public.flipdesk_grading_roi_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select
      (grade_value is not null) as is_graded,
      (list_date is not null)   as listed_hit,
      (sale_date is not null)   as sold_hit,
      net_profit,
      days_to_sell
    from public.items_full
  ),
  side as (
    select
      is_graded,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(net_profit) filter (where sold_hit and net_profit is not null) as avg_net_profit,
      percentile_cont(0.5) within group (order by days_to_sell)
        filter (where sold_hit and days_to_sell is not null) as median_days
    from base
    group by is_graded
  ),
  g as (select * from side where is_graded),
  u as (select * from side where not is_graded)
  select jsonb_build_object(
    'graded', jsonb_build_object(
      'listed', coalesce((select listed from g), 0),
      'sold', coalesce((select sold from g), 0),
      'sellThrough', (select case when listed > 0 then sold::numeric / listed else null end from g),
      'avgNetProfit', (select avg_net_profit from g),
      'medianDaysToSell', (select median_days from g)
    ),
    'ungraded', jsonb_build_object(
      'listed', coalesce((select listed from u), 0),
      'sold', coalesce((select sold from u), 0),
      'sellThrough', (select case when listed > 0 then sold::numeric / listed else null end from u),
      'avgNetProfit', (select avg_net_profit from u),
      'medianDaysToSell', (select median_days from u)
    ),
    'sellThroughLift', (
      select gst - ust
      from (select case when g.listed > 0 then g.sold::numeric / g.listed end as gst from g) gx,
           (select case when u.listed > 0 then u.sold::numeric / u.listed end as ust from u) ux
    ),
    'netProfitLift', (
      select g.avg_net_profit - u.avg_net_profit
      from g, u
      where g.avg_net_profit is not null and u.avg_net_profit is not null
    ),
    'daysFaster', (
      select u.median_days - g.median_days
      from g, u
      where g.median_days is not null and u.median_days is not null
    ),
    'meaningful', (
      coalesce((select sold from g), 0) >= 5
      and coalesce((select sold from u), 0) >= 5
    )
  );
$$;

-- ── Per-bucket breakdown: add medianDaysToSell per side ─────────────────────
-- Otherwise unchanged from 00148 (sold = sale_price not null; same price bands,
-- same labels incl. the en-dash, same MIN_BUCKET_SIZE=5 meaningful test, same
-- ordering).
create or replace function public.flipdesk_grading_roi()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with sold as (
    select
      coalesce(nullif(trim(category), ''), 'Uncategorized') as category,
      case
        when sale_price < 50  then 'Under $50'
        when sale_price < 150 then '$50–150'
        else                       '$150+'
      end as band,
      (grade_value is not null) as is_graded,
      net_profit,
      sale_price,
      days_to_sell
    from public.items_full
    where sale_price is not null
  ),
  agg as (
    select
      category,
      band,
      count(*) filter (where is_graded)         as graded_count,
      avg(net_profit) filter (where is_graded)  as graded_profit,
      avg(sale_price) filter (where is_graded)  as graded_price,
      percentile_cont(0.5) within group (order by days_to_sell)
        filter (where is_graded and days_to_sell is not null) as graded_days,
      count(*) filter (where not is_graded)     as ungraded_count,
      avg(net_profit) filter (where not is_graded) as ungraded_profit,
      avg(sale_price) filter (where not is_graded) as ungraded_price,
      percentile_cont(0.5) within group (order by days_to_sell)
        filter (where not is_graded and days_to_sell is not null) as ungraded_days
    from sold
    group by category, band
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'category', category,
        'band', band,
        'graded', jsonb_build_object(
          'count', graded_count,
          'avgNetProfit', graded_profit,
          'avgSalePrice', graded_price,
          'medianDaysToSell', graded_days
        ),
        'ungraded', jsonb_build_object(
          'count', ungraded_count,
          'avgNetProfit', ungraded_profit,
          'avgSalePrice', ungraded_price,
          'medianDaysToSell', ungraded_days
        ),
        'netProfitLift', case
          when graded_profit is not null and ungraded_profit is not null
            then graded_profit - ungraded_profit
          else null
        end,
        'meaningful', (graded_count >= 5 and ungraded_count >= 5)
      )
      order by category,
        case band when 'Under $50' then 0 when '$50–150' then 1 else 2 end
    ),
    '[]'::jsonb
  )
  from agg;
$$;

grant execute on function public.flipdesk_grading_roi_summary() to authenticated;
grant execute on function public.flipdesk_grading_roi_summary() to service_role;
grant execute on function public.flipdesk_grading_roi() to authenticated;
grant execute on function public.flipdesk_grading_roi() to service_role;

COMMIT;
