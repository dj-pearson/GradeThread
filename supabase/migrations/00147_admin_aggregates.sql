-- US-415: Server-side aggregation + pagination support for the admin surfaces.
--
-- Several admin pages previously pulled unbounded `select('*')` result sets into
-- the browser and aggregated / paginated in JS:
--   * admin/system.tsx   loaded ALL users + submissions + submission_images +
--                        grade_reports + sales just to compute counts and a few
--                        time-bucketed charts.
--   * admin/users.tsx    loaded ALL submissions just to attach a per-user
--                        submission count + last-active date.
--   * admin/audit-log.tsx loaded the ENTIRE admin_audit_log + users table to
--                        build filter dropdowns and paginate client-side.
--
-- These payloads scale linearly with platform size and time out as the platform
-- grows. This migration moves the aggregation into Postgres (mirroring the
-- US-403/US-404 finances/inventory RPCs) so the client receives compact,
-- size-independent summaries, and lets the list pages paginate server-side via
-- `.range()` + `count: 'exact'`.
--
-- SECURITY DEFINER + an explicit is_admin() guard: every function below reads
-- platform-wide (cross-tenant) data, so it cannot run under the caller's RLS
-- (a non-admin would see only their own rows; submission_images has no admin
-- read policy at all). The guard raises if a non-admin calls in, so the
-- definer rights never expose data to a non-admin.

-- ── 1. System health / metrics dashboard ──────────────────────────────────
-- Returns one compact JSON document with every number admin/system.tsx renders
-- (db latency is still measured client-side with a ping; everything else is
-- aggregated here). plan_counts is returned raw so the client keeps plan
-- pricing (MRR) in one place — src/lib/constants PLANS.
create or replace function public.admin_system_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin_system_metrics: admin role required'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'queue', jsonb_build_object(
      'pendingCount', (
        select count(*)::int from public.submissions where status = 'pending'
      ),
      'processingCount', (
        select count(*)::int from public.submissions where status = 'processing'
      ),
      'failedLast24h', (
        select count(*)::int from public.submissions
        where status = 'failed' and created_at >= now() - interval '24 hours'
      ),
      -- avg minutes from submission.created_at to its grade_report.created_at,
      -- over completed submissions that produced a report (positive deltas).
      'avgProcessingTimeMin', coalesce((
        select round(avg(extract(epoch from (gr.created_at - s.created_at)) / 60.0)::numeric, 1)
        from public.submissions s
        join public.grade_reports gr on gr.submission_id = s.id
        where s.status = 'completed'
          and gr.created_at > s.created_at
      ), 0)
    ),
    'storage', jsonb_build_object(
      'totalImages', (select count(*)::int from public.submission_images)
    ),
    'subscriptions', jsonb_build_object(
      'planCounts', (
        select coalesce(jsonb_object_agg(plan, cnt), '{}'::jsonb)
        from (
          select plan::text as plan, count(*)::int as cnt
          from public.users group by plan
        ) p
      ),
      'totalPaid', (
        select count(*)::int from public.users where plan <> 'free'
      ),
      -- Estimated 30-day churn: users who signed up >30d ago, are now on free,
      -- and have an own sale in the last 30 days (i.e. were recently active but
      -- not paying). churn% = activeFree / (paid + activeFree).
      'churnFreeWithActivity', (
        select count(distinct u.id)::int
        from public.users u
        where u.plan = 'free'
          and u.created_at < now() - interval '30 days'
          and exists (
            select 1 from public.sales sa
            where sa.user_id = u.id and sa.created_at >= now() - interval '30 days'
          )
      )
    ),
    -- Last 24 hourly buckets: submissions + distinct users per hour.
    'hourlyTraffic', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'start', b.bucket,
        'submissions', coalesce(agg.subs, 0),
        'uniqueUsers', coalesce(agg.users, 0)
      ) order by b.bucket), '[]'::jsonb)
      from generate_series(
        date_trunc('hour', now()) - interval '23 hours',
        date_trunc('hour', now()),
        interval '1 hour'
      ) as b(bucket)
      left join lateral (
        select count(*)::int as subs, count(distinct s.user_id)::int as users
        from public.submissions s
        where s.created_at >= b.bucket and s.created_at < b.bucket + interval '1 hour'
      ) agg on true
    ),
    -- Last 30 daily buckets: distinct users per day.
    'dailyUsers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'start', b.bucket,
        'uniqueUsers', coalesce(agg.users, 0)
      ) order by b.bucket), '[]'::jsonb)
      from generate_series(
        date_trunc('day', now()) - interval '29 days',
        date_trunc('day', now()),
        interval '1 day'
      ) as b(bucket)
      left join lateral (
        select count(distinct s.user_id)::int as users
        from public.submissions s
        where s.created_at >= b.bucket and s.created_at < b.bucket + interval '1 day'
      ) agg on true
    ),
    -- Last 7 daily buckets: total + failed submissions per day.
    'errorRate', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'start', b.bucket,
        'totalSubmissions', coalesce(agg.total, 0),
        'failedCount', coalesce(agg.failed, 0)
      ) order by b.bucket), '[]'::jsonb)
      from generate_series(
        date_trunc('day', now()) - interval '6 days',
        date_trunc('day', now()),
        interval '1 day'
      ) as b(bucket)
      left join lateral (
        select
          count(*)::int as total,
          (count(*) filter (where s.status = 'failed'))::int as failed
        from public.submissions s
        where s.created_at >= b.bucket and s.created_at < b.bucket + interval '1 day'
      ) agg on true
    )
  ) into result;

  return result;
end;
$$;

comment on function public.admin_system_metrics() is
  'US-415: platform-wide system dashboard metrics as one jsonb document. '
  'SECURITY DEFINER + is_admin() guard (reads cross-tenant data).';

grant execute on function public.admin_system_metrics() to authenticated;
grant execute on function public.admin_system_metrics() to service_role;

-- ── 2. Per-user submission stats (bounded to the displayed page) ───────────
-- admin/users.tsx paginates users server-side and passes only the ~20 user ids
-- on the current page; this returns their submission count + last submission
-- date as a compact { "<uuid>": { "count": N, "last": "..." } } object.
create or replace function public.admin_user_list_stats(p_user_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin_user_list_stats: admin role required'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_object_agg(user_id::text, jsonb_build_object(
    'count', cnt,
    'last', last_at
  )), '{}'::jsonb)
  into result
  from (
    select user_id, count(*)::int as cnt, max(created_at) as last_at
    from public.submissions
    where user_id = any(p_user_ids)
    group by user_id
  ) s;

  return result;
end;
$$;

comment on function public.admin_user_list_stats(uuid[]) is
  'US-415: submission count + last submission per user for a bounded page of '
  'user ids. SECURITY DEFINER + is_admin() guard.';

grant execute on function public.admin_user_list_stats(uuid[]) to authenticated;
grant execute on function public.admin_user_list_stats(uuid[]) to service_role;

-- ── 3. Audit-log filter dropdown options ───────────────────────────────────
-- admin/audit-log.tsx populates its admin/action/target dropdowns from DISTINCT
-- values across the whole log — a grouped query instead of downloading every row.
create or replace function public.admin_audit_log_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin_audit_log_filter_options: admin role required'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'actions', coalesce((
      select jsonb_agg(action order by action)
      from (select distinct action from public.admin_audit_log) a
    ), '[]'::jsonb),
    'targetTypes', coalesce((
      select jsonb_agg(target_type order by target_type)
      from (select distinct target_type from public.admin_audit_log) t
    ), '[]'::jsonb),
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id,
        'label', coalesce(nullif(u.full_name, ''), u.email, u.id::text)
      ) order by coalesce(nullif(u.full_name, ''), u.email, u.id::text))
      from (
        select distinct admin_user_id from public.admin_audit_log
        where admin_user_id is not null
      ) d
      join public.users u on u.id = d.admin_user_id
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

comment on function public.admin_audit_log_filter_options() is
  'US-415: distinct admin/action/target filter options for the audit log. '
  'SECURITY DEFINER + is_admin() guard.';

grant execute on function public.admin_audit_log_filter_options() to authenticated;
grant execute on function public.admin_audit_log_filter_options() to service_role;
