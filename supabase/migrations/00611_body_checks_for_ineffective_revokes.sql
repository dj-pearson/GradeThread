-- US-2666 AC1: the six functions whose `REVOKE ... FROM anon` never denied anon
-- get an authorization check in the BODY instead.
--
-- Mechanism and proof: vault/20-domain/postgres-revoke-from-anon-is-a-noop.md.
-- Short version: CREATE FUNCTION grants EXECUTE to PUBLIC, every role belongs to
-- PUBLIC, so revoking a role by name leaves the grant it actually executes
-- through. Six functions have been anon-callable the whole time; POSTing
-- flipdesk_overview_metrics with the public anon key returned 200 in production.
--
-- WHY NOT A REVOKE. Two traps, both found while specifying one:
--   1. A denied call from anon or authenticated segfaults Postgres on this image
--      (US-2403), and 00527 is a standing DO NOT APPLY.
--   2. On five of the six, service_role holds EXECUTE only THROUGH the PUBLIC
--      grant; there is no explicit grant to it anywhere. `REVOKE ... FROM PUBLIC`
--      would have stripped the edge's own access and taken out the paid Snap
--      path. A body check arms neither trap: it revokes nothing and raises an
--      ordinary 42501. admin_revenue_metrics (00514) is the model, and it is
--      anon-EXECUTABLE and still safe.
--
-- WHO IS LET THROUGH, from the traced call sites:
--   reserve_snap                routes/grade.ts:1570           service_role
--   refund_snap                 lib/grade-refund.ts:204        service_role
--   data_integrity_scan         lib/integrity-scan.ts:19       service_role
--   north_star_weekly_counts    routes/jobs-north-star.ts:74   service_role (cron)
--   north_star_lifetime_counts  routes/jobs-north-star.ts:140  service_role (cron)
--   flipdesk_overview_metrics   src/hooks/use-flipdesk-overview.ts:121 authenticated
-- No caller is anon. A NULL auth.role() is passed through deliberately: that is
-- an in-database caller (psql, pg_cron), never a PostgREST request, because both
-- the anon and the authenticated keys carry a role claim.
--
-- Bodies below are the originals with ONLY the guard added. The four `language
-- sql` ones become plpgsql because SQL cannot raise; `#variable_conflict
-- use_column` keeps the RETURNS TABLE output names resolving as columns.

-- --- Snap quota (00099) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_snap(p_user_id uuid, p_limit int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_used  int;
  v_reset timestamptz;
  v_rolled boolean;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'reserve_snap: service role required' USING ERRCODE = '42501';
  END IF;

  SELECT snaps_used_this_month, snaps_reset_at
    INTO v_used, v_reset
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_rolled := date_trunc('month', v_reset) < date_trunc('month', now());
  IF v_rolled THEN
    v_used := 0;
  END IF;

  IF p_limit <> -1 AND v_used >= p_limit THEN
    UPDATE public.users
      SET snaps_used_this_month = v_used,
          snaps_reset_at = CASE WHEN v_rolled THEN now() ELSE snaps_reset_at END
      WHERE id = p_user_id;
    RETURN false;
  END IF;

  UPDATE public.users
    SET snaps_used_this_month = v_used + 1,
        snaps_reset_at = CASE WHEN v_rolled THEN now() ELSE snaps_reset_at END
    WHERE id = p_user_id;
  RETURN true;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.refund_snap(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'refund_snap: service role required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.users
    SET snaps_used_this_month = greatest(0, snaps_used_this_month - 1)
    WHERE id = p_user_id;
END;
$fn$;

-- --- Integrity scan (00097) ------------------------------------------
CREATE OR REPLACE FUNCTION public.data_integrity_scan()
RETURNS TABLE(anomaly text, count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
#variable_conflict use_column
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'data_integrity_scan: service role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  -- repricing_suggestions whose denormalized user_id drifted from the item's
  -- real owner (the CHECK constraints already prevent invalid status/reason).
  SELECT 'repricing_user_id_drift'::text, count(*)::bigint
  FROM public.repricing_suggestions rs
  JOIN public.inventory_items ii ON ii.id = rs.inventory_item_id
  WHERE rs.user_id <> ii.user_id
  UNION ALL
  -- email outbox stuck pending far past its last scheduled attempt (the retry
  -- cron should have moved it to sent/dead_letter).
  SELECT 'email_deliveries_stuck_pending'::text, count(*)::bigint
  FROM public.email_deliveries
  WHERE status = 'pending' AND next_attempt_at < now() - interval '6 hours'
  UNION ALL
  -- submissions stranded in 'processing' beyond the stuck-recovery window
  -- (the US-495 sweep should have failed+refunded them).
  SELECT 'submissions_stuck_processing'::text, count(*)::bigint
  FROM public.submissions
  WHERE status = 'processing' AND updated_at < now() - interval '1 hour';
END;
$fn$;

-- --- North Star aggregates (00170) -----------------------------------
CREATE OR REPLACE FUNCTION public.north_star_weekly_counts(
  p_start timestamptz,
  p_end   timestamptz
)
RETURNS TABLE (user_id uuid, items_listed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
#variable_conflict use_column
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'north_star_weekly_counts: service role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT ii.user_id, COUNT(*)::bigint AS items_listed
  FROM public.listings l
  JOIN public.inventory_items ii ON ii.id = l.inventory_item_id
  WHERE l.listed_at >= p_start
    AND l.listed_at <  p_end
  GROUP BY ii.user_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.north_star_lifetime_counts(
  p_user_ids uuid[]
)
RETURNS TABLE (user_id uuid, total bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
#variable_conflict use_column
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'north_star_lifetime_counts: service role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT ii.user_id, COUNT(*)::bigint AS total
  FROM public.listings l
  JOIN public.inventory_items ii ON ii.id = l.inventory_item_id
  WHERE ii.user_id = ANY(p_user_ids)
  GROUP BY ii.user_id;
END;
$fn$;

-- --- FlipDesk Overview (00594) ---------------------------------------
-- The only one of the six a client calls directly, and the one an anon POST
-- reached in production. SECURITY INVOKER is unchanged, so RLS still scopes
-- every figure to the caller; the guard turns a 200-with-zeros into a 42501.
create or replace function public.flipdesk_overview_metrics(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_tz text default 'UTC',
  p_aging_days int default 14,
  p_limit int default 50
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $fn$
declare
  v_result jsonb;
begin
  if auth.role() is not null and auth.role() not in ('service_role', 'authenticated') then
    raise exception 'flipdesk_overview_metrics: sign-in required' using errcode = '42501';
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
  ) into v_result;

  return v_result;
end;
$fn$;

comment on function public.reserve_snap(uuid, int) is
  'US-2666: service-role-only, checked in the body because the 00099 revoke never denied anon.';
comment on function public.refund_snap(uuid) is
  'US-2666: service-role-only, checked in the body because the 00099 revoke never denied anon.';
comment on function public.data_integrity_scan() is
  'US-504 / US-2666: anomaly classes with counts for the cron. Service-role-only, checked in the body.';
comment on function public.north_star_weekly_counts(timestamptz, timestamptz) is
  'US-597 / US-2666: items-listed-per-week for the digest cron. Service-role-only, checked in the body.';
comment on function public.north_star_lifetime_counts(uuid[]) is
  'US-597 / US-2666: lifetime items-listed for the given users. Service-role-only, checked in the body.';
comment on function public.flipdesk_overview_metrics(timestamptz, timestamptz, text, int, int) is
  'US-2547 / US-2666: the FlipDesk Overview summary as one jsonb document. SECURITY INVOKER so RLS scopes every figure; the body refuses an anon caller.';

insert into public.applied_migrations (version) values ('00611') on conflict do nothing;
