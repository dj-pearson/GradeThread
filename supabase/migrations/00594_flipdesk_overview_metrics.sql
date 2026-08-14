-- US-2547: one server-side aggregate behind the FlipDesk Overview.
--
-- The page used to read every items_full row for the account and loop it in the
-- browser to derive twelve numbers and four short lists. The transfer grew with
-- the account while the output stayed the same size, and the whole scan re-ran
-- on every render of a page whose job is a summary.
--
-- This returns that summary as one jsonb document. SECURITY INVOKER over
-- items_full (itself security_invoker), so RLS scopes it to the caller exactly
-- as the direct read did — same rows, same rules, counted in SQL.
--
-- p_from/p_to are the date range the page offers (null = unbounded). Range-bound
-- figures are the flow ones (listed, sold, revenue, profit, top brands, recent
-- sales); the state-of-now ones (inventory value, aging, stale) ignore it,
-- because "what is stuck right now" has no meaning inside a past window.
--
-- p_tz is the VIEWER's IANA zone, used only to bucket weeks for the North Star
-- streak. Weeks are Monday-anchored (date_trunc('week') already is), which is
-- what src/lib/north-star.ts computes locally. An unknown zone falls back to UTC
-- rather than raising.

create or replace function public.flipdesk_overview_metrics(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_tz text default 'UTC',
  p_aging_days int default 14,
  p_limit int default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with bounds as (
  select
    coalesce(p_from, '-infinity'::timestamptz) as lo,
    coalesce(p_to, 'infinity'::timestamptz)    as hi,
    greatest(coalesce(p_aging_days, 14), 0)    as aging_days,
    least(greatest(coalesce(p_limit, 50), 1), 200) as row_limit,
    coalesce(
      (select n.name from pg_timezone_names n where n.name = p_tz),
      'UTC'
    ) as tz
),
-- The bounds ride along as columns rather than as scalar subqueries repeated
-- inside a dozen FILTER clauses: one row cross-joined onto the scan, and every
-- predicate below reads a plain column.
src as (
  select
    f.id,
    f.item_title,
    f.brand,
    f.status::text as status,
    f.updated_at,
    f.list_date,
    f.list_price,
    f.target_price,
    f.grade_value,
    f.listing_status,
    f.listing_watchers,
    f.sale_date,
    f.sale_price,
    f.net_profit,
    b.aging_days,
    -- Same definition the client filter uses for `days_in_status`
    -- (src/lib/item-filter.ts): whole days since the row last moved.
    floor(extract(epoch from (now() - f.updated_at)) / 86400)::int as days_in_status,
    floor(extract(epoch from (now() - f.list_date)) / 86400)::int  as days_listed,
    f.status::text in (
      'sourced','acquired','cataloged','measured',
      'photographed','grading','graded','comped','drafted','listed'
    ) as is_active_stage,
    (
      f.sale_status = 'completed'
      and f.sale_date is not null
      and f.sale_date >= b.lo
      and f.sale_date <  b.hi
    ) as in_sold_window,
    (
      f.sale_date is not null
      and f.sale_date >= b.lo
      and f.sale_date <  b.hi
    ) as in_sale_window,
    (
      f.list_date is not null
      and f.list_date >= b.lo
      and f.list_date <  b.hi
    ) as in_list_window
  from public.items_full f
  cross join bounds b
),
totals as (
  select
    count(*)::int as total,
    -- Market value, not cost basis: the live listing price, else the target.
    coalesce(
      sum(coalesce(list_price, target_price, 0)) filter (where is_active_stage),
      0
    )::numeric as inventory_value,
    count(*) filter (where in_list_window)::int as listed_in_range,
    count(*) filter (where in_sold_window)::int   as sold_in_range,
    coalesce(sum(coalesce(sale_price, 0)) filter (where in_sold_window), 0)::numeric as gross_in_range,
    coalesce(sum(coalesce(net_profit, 0)) filter (where in_sold_window), 0)::numeric as net_in_range,
    count(*) filter (where list_date is not null)::int as lifetime_listed,
    count(*) filter (
      where is_active_stage
        and updated_at is not null
        and days_in_status >= aging_days
    )::int as aging_count,
    count(*) filter (
      where listing_status = 'active'
        and list_date is not null
        and coalesce(listing_watchers, 0) = 0
        and days_listed >= aging_days
    )::int as stale_count
  from src
),
by_status as (
  select coalesce(jsonb_object_agg(status, cnt), '{}'::jsonb) as obj
  from (select status, count(*)::int as cnt from src group by status) s
),
aging as (
  select coalesce(jsonb_agg(to_jsonb(t) order by t.days desc), '[]'::jsonb) as rows
  from (
    select id, item_title, brand, status, days_in_status as days
    from src
    where is_active_stage
      and updated_at is not null
      and days_in_status >= aging_days
    order by days_in_status desc
    limit (select row_limit from bounds)
  ) t
),
stale as (
  select coalesce(jsonb_agg(to_jsonb(t) order by t.days desc), '[]'::jsonb) as rows
  from (
    select id, item_title, brand, list_price, grade_value, days_listed as days
    from src
    where listing_status = 'active'
      and list_date is not null
      and coalesce(listing_watchers, 0) = 0
      and days_listed >= aging_days
    order by days_listed desc
    limit (select row_limit from bounds)
  ) t
),
top_brands as (
  select coalesce(jsonb_agg(to_jsonb(t) order by t.profit desc), '[]'::jsonb) as rows
  from (
    select brand, sum(net_profit)::numeric as profit, count(*)::int as sold
    from src
    where brand is not null
      and net_profit is not null
      and in_sold_window
    group by brand
    order by sum(net_profit) desc
    limit 5
  ) t
),
recent_sales as (
  select coalesce(jsonb_agg(to_jsonb(t) order by t.sale_date desc), '[]'::jsonb) as rows
  from (
    select id, item_title, brand, sale_date, sale_price, net_profit
    from src
    where in_sale_window
    order by sale_date desc
    limit 6
  ) t
),
list_weeks as (
  select coalesce(jsonb_agg(to_jsonb(t) order by t.week desc), '[]'::jsonb) as rows
  from (
    select
      to_char(
        date_trunc('week', s.list_date at time zone b.tz),
        'YYYY-MM-DD'
      ) as week,
      count(*)::int as count
    from src s
    cross join bounds b
    where s.list_date is not null
    group by 1
    order by 1 desc
    -- Two years of weeks is far more than the streak walk can consume, and it
    -- caps the payload for an account that has listed every week for a decade.
    limit 104
  ) t
)
select jsonb_build_object(
  'total',          (select total from totals),
  'byStatus',       (select obj from by_status),
  'inventoryValue', (select inventory_value from totals),
  'listedInRange',  (select listed_in_range from totals),
  'soldInRange',    (select sold_in_range from totals),
  'grossInRange',   (select gross_in_range from totals),
  'netInRange',     (select net_in_range from totals),
  'agingCount',     (select aging_count from totals),
  'agingItems',     (select rows from aging),
  'staleCount',     (select stale_count from totals),
  'staleListings',  (select rows from stale),
  'topBrands',      (select rows from top_brands),
  'recentSales',    (select rows from recent_sales),
  'listWeeks',      (select rows from list_weeks),
  'lifetimeListed', (select lifetime_listed from totals)
);
$$;

comment on function public.flipdesk_overview_metrics(timestamptz, timestamptz, text, int, int) is
  'US-2547: the FlipDesk Overview summary as one jsonb document — pipeline counts, '
  'range-bound flow figures, aging/stale lists and the North Star week buckets. '
  'SECURITY INVOKER so RLS scopes every figure to the caller.';

revoke all on function public.flipdesk_overview_metrics(timestamptz, timestamptz, text, int, int) from anon;
grant execute on function public.flipdesk_overview_metrics(timestamptz, timestamptz, text, int, int) to authenticated;
grant execute on function public.flipdesk_overview_metrics(timestamptz, timestamptz, text, int, int) to service_role;

insert into public.applied_migrations (version) values ('00594') on conflict do nothing;
