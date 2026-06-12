-- US-418: Server-side aggregation for the FlipDesk Analytics surfaces.
--
-- analytics.tsx previously pulled a slim-but-unbounded projection of EVERY
-- items_full row into the browser (one row per inventory item) and computed
-- sell-through, profit, and grading-ROI buckets in JS over the full set. The
-- payload therefore scaled linearly with inventory size even though the page
-- only ever renders a handful of aggregated rows (one per category/brand/source,
-- or one per category × price-band bucket).
--
-- These two functions move that aggregation into Postgres (mirroring the
-- US-403/US-404 finances/inventory and US-415 admin RPCs). The client now
-- receives compact summary rows whose count is bounded by the number of distinct
-- groups / buckets — independent of inventory size.
--
-- SECURITY INVOKER: both functions read items_full, a security_invoker view, so
-- the caller's RLS (owner + workspace-member visibility) applies exactly as it
-- did when the page queried the view directly. No new data is exposed and no
-- explicit user_id scoping is needed (same model as finances_dashboard).

BEGIN;

-- ── 1. Sell-through + profit by category / brand / source ──────────────────
-- Mirrors sellThroughByGroup() in src/lib/flipdesk-analytics.ts:
--   * an item counts toward "listed" when it has a list_date on/after the period
--     start (or any list_date when p_period_start is null), and toward "sold"
--     when it has a sale_date in the same window;
--   * profit/days metrics are computed over the sold-in-window subset only;
--   * median days-to-sell uses percentile_cont(0.5), which matches the JS
--     even-length "average the two middle values" / odd-length "middle value".
-- Rows are ordered sold desc, listed desc — the same order the JS produced.
create or replace function public.flipdesk_sell_through(
  p_group_key text default 'category',
  p_period_start date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with hits as (
    select
      case p_group_key
        when 'brand'  then coalesce(nullif(trim(brand), ''), 'No brand')
        when 'source' then coalesce(nullif(trim(source_name), ''), 'No source')
        else               coalesce(nullif(trim(category), ''), 'Uncategorized')
      end as grp,
      (list_date is not null
        and (p_period_start is null or list_date::date >= p_period_start)) as listed_hit,
      (sale_date is not null
        and (p_period_start is null or sale_date::date >= p_period_start)) as sold_hit,
      net_profit,
      days_to_sell
    from public.items_full
  ),
  agg as (
    select
      grp,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(net_profit) filter (where sold_hit and net_profit is not null) as avg_net_profit,
      percentile_cont(0.5) within group (order by days_to_sell)
        filter (where sold_hit and days_to_sell is not null) as median_days
    from hits
    where listed_hit or sold_hit
    group by grp
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'group', grp,
        'listed', listed,
        'sold', sold,
        'sellThrough', case when listed > 0 then sold::numeric / listed else null end,
        'avgNetProfit', avg_net_profit,
        'medianDaysToSell', median_days
      )
      order by sold desc, listed desc
    ),
    '[]'::jsonb
  )
  from agg;
$$;

-- ── 2. Grading ROI: graded vs ungraded sold items, by category × price band ─
-- Mirrors gradingRoiBuckets() in src/lib/flipdesk-analytics.ts. Sold = any item
-- with a non-null sale_price. Price bands and labels are reproduced exactly
-- (note the en-dash in "$50–150"). A bucket is "meaningful" only when both sides
-- have >= 5 items (MIN_BUCKET_SIZE). Rows are ordered category asc, then band.
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
      sale_price
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
      count(*) filter (where not is_graded)     as ungraded_count,
      avg(net_profit) filter (where not is_graded) as ungraded_profit,
      avg(sale_price) filter (where not is_graded) as ungraded_price
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
          'avgSalePrice', graded_price
        ),
        'ungraded', jsonb_build_object(
          'count', ungraded_count,
          'avgNetProfit', ungraded_profit,
          'avgSalePrice', ungraded_price
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

grant execute on function public.flipdesk_sell_through(text, date) to authenticated;
grant execute on function public.flipdesk_sell_through(text, date) to service_role;
grant execute on function public.flipdesk_grading_roi() to authenticated;
grant execute on function public.flipdesk_grading_roi() to service_role;

COMMIT;
