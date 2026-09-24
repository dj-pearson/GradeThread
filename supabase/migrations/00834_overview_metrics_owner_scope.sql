-- INV-D1 follow-up: the FlipDesk Overview reads ONE workspace.
--
-- flipdesk_overview_metrics (00594, guarded against anon by 00611) is SECURITY
-- INVOKER over items_full, whose SELECT policy admits the caller's own rows OR
-- any workspace they are a member of. It never filtered by user_id, so a seller
-- who owns items and also belongs to another workspace saw both tenants' totals
-- blended on /dashboard: pipeline counts, inventory value, sold, gross, net,
-- aging, stale, top brands, recent sales and the North Star weeks. 00833 fixed
-- the same gap in flipdesk_listing_page and inventory_status_counts; this is
-- that fix, copied, for the third function.
--
-- p_owner_id is the workspace on screen. It is checked, not trusted: the caller
-- must be that owner, a member of that owner's workspace
-- (public.is_workspace_member), or the service role, else 42501. NULL means
-- auth.uid(), the caller's OWN rows, which is what a client built before this
-- migration sends. 00611's anon refusal is kept exactly as it was and runs
-- first.
--
-- One correctness fix rides along because it is the same function: recentSales
-- listed every sale in the window, refunded and cancelled included, while the
-- Sold tile beside it counts only completed ones (00111: metrics exclude
-- anything but 'completed'). It now reads the same in_sold_window predicate.
--
-- The signature changes, so the old one is DROPPED: a defaulted extra argument
-- would create a second overload, and PostgREST refuses a call two overloads
-- could answer. Grants are replayed as they were (authenticated, service_role;
-- PUBLIC comes back with CREATE). No revokes: US-2403, and 00611's header.
--
-- Proof: node scripts/check-overview-owner-scope.mjs --dsn "postgresql://..."

drop function if exists public.flipdesk_overview_metrics(timestamptz, timestamptz, text, int, int);

create or replace function public.flipdesk_overview_metrics(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_tz text default 'UTC',
  p_aging_days int default 14,
  p_limit int default 50,
  -- 00834: the workspace on screen. NULL = the caller's own rows.
  p_owner_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $fn$
declare
  v_result jsonb;
  -- Whose rows. NULL falls back to the caller, never to "everything RLS
  -- admits", which is what blended two workspaces together.
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  if auth.role() is not null and auth.role() not in ('service_role', 'authenticated') then
    raise exception 'flipdesk_overview_metrics: sign-in required' using errcode = '42501';
  end if;

  -- The owner, any member of the owner's workspace, or the service role.
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'flipdesk_overview_metrics: not a member of that workspace'
      using errcode = '42501';
  end if;

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
        f.list_date is not null
        and f.list_date >= b.lo
        and f.list_date <  b.hi
      ) as in_list_window
    from public.items_full f
    cross join bounds b
    -- 00834: one workspace. A NULL owner (service role, no sub) matches nothing.
    where f.user_id = v_owner
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
      -- 00834: completed sales only, the same rows soldInRange counts. It
      -- used to list refunded and cancelled sales beside a tile excluding them.
      where in_sold_window
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
  ) into v_result;

  return v_result;
end;
$fn$;

comment on function public.flipdesk_overview_metrics(timestamptz, timestamptz, text, int, int, uuid) is
  'US-2547 / US-2666: the FlipDesk Overview summary as one jsonb document. SECURITY '
  'INVOKER; the body refuses an anon caller. 00834: one workspace (p_owner_id, NULL = '
  'the caller''s own), 42501 for a non-member; recentSales lists completed sales only.';

-- The same grants the function had before; see the header on revokes.
grant execute on function public.flipdesk_overview_metrics(timestamptz, timestamptz, text, int, int, uuid) to authenticated;
grant execute on function public.flipdesk_overview_metrics(timestamptz, timestamptz, text, int, int, uuid) to service_role;

insert into public.applied_migrations (version) values ('00834') on conflict do nothing;
