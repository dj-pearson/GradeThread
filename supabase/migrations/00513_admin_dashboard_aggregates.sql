-- US-2390: exact server-side aggregates for the admin dashboard.
--
-- GET /admin-dashboard/summary derived its numbers in JavaScript from three
-- unbounded reads. PostgREST caps any response at `db-max-rows` and reports the
-- truncation only in a Content-Range header supabase-js does not surface, so
-- past that ceiling every number was computed on a fraction of the corpus and
-- came back looking normal. These three functions move the aggregation into
-- Postgres, where the row ceiling cannot apply: each returns a bounded document
-- (a handful of scalars, 30 buckets, 90 buckets, 10 rows) no matter how large
-- the platform gets.
--
-- GUARD: `auth.role() = 'service_role' or is_admin()`, the 00207/00227 pattern.
-- The edge calls these through the service-role client, where auth.uid() is
-- NULL and a bare is_admin() check would always raise.

-- ── 1. The scalar KPIs that need VALUES rather than counts ─────────────────
-- averageGrade is an all-time mean and revenueThisMonth an all-time-to-date sum
-- — the two numbers a bounded read corrupts silently rather than visibly. Every
-- other KPI on the dashboard is count-shaped and is served by a
-- `count: 'exact', head: true` query in the route, which reads zero rows.
create or replace function public.admin_dashboard_aggregates(
  p_month_start timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'admin_dashboard_aggregates: admin role required'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    -- Rounded to 1dp here rather than in JS so the number the operator reads is
    -- the number the database computed.
    'averageGrade', coalesce((
      select round(avg(overall_score)::numeric, 1)
      from public.grade_reports where overall_score > 0
    ), 0),
    'gradedReportCount', coalesce((
      select count(*) from public.grade_reports where overall_score > 0
    ), 0),
    'revenueThisMonth', coalesce((
      select sum(sale_price) from public.sales where sale_date >= p_month_start
    ), 0)
  ) into result;

  return result;
end;
$$;

comment on function public.admin_dashboard_aggregates(timestamptz) is
  'US-2390: all-time average grade + month-to-date revenue for the admin '
  'dashboard, aggregated in SQL so no row ceiling can truncate them. '
  'SECURITY DEFINER + service_role/is_admin() guard.';

grant execute on function public.admin_dashboard_aggregates(timestamptz) to authenticated;
grant execute on function public.admin_dashboard_aggregates(timestamptz) to service_role;

-- ── 2. The 30-day charts ───────────────────────────────────────────────────
-- The CALLER passes the bucket edges (N+1 timestamps for N buckets) rather than
-- a day count, and that is deliberate: the edge already computes local-midnight
-- boundaries to build the chart labels, so passing them keeps labels and counts
-- derived from one set of instants. Computing day boundaries independently in
-- SQL would silently disagree with the labels whenever the database session's
-- timezone differs from the container's — a whole-column-shifted chart that
-- looks perfectly plausible.
create or replace function public.admin_dashboard_daily_series(
  p_edges timestamptz[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  edge_count int := coalesce(array_length(p_edges, 1), 0);
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'admin_dashboard_daily_series: admin role required'
      using errcode = '42501';
  end if;

  -- Fewer than two edges describes no bucket at all.
  if edge_count < 2 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'start', b.start_at,
    'submissions', (
      select count(*) from public.submissions s
      where s.created_at >= b.start_at and s.created_at < b.end_at
    ),
    'newUsers', (
      select count(*) from public.users u
      where u.created_at >= b.start_at and u.created_at < b.end_at
    ),
    'revenue', coalesce((
      select sum(sa.sale_price) from public.sales sa
      where sa.sale_date >= b.start_at and sa.sale_date < b.end_at
    ), 0)
  ) order by b.idx), '[]'::jsonb)
  into result
  from (
    select g.i as idx, p_edges[g.i] as start_at, p_edges[g.i + 1] as end_at
    from generate_series(1, edge_count - 1) as g(i)
  ) b;

  return result;
end;
$$;

comment on function public.admin_dashboard_daily_series(timestamptz[]) is
  'US-2390: per-bucket submission / new-user / revenue counts for the admin '
  'dashboard charts. Caller supplies N+1 bucket edges so labels and counts '
  'share one set of instants. SECURITY DEFINER + service_role/is_admin() guard.';

grant execute on function public.admin_dashboard_daily_series(timestamptz[]) to authenticated;
grant execute on function public.admin_dashboard_daily_series(timestamptz[]) to service_role;

-- ── 3. The row-level analytics PlatformAnalytics used to build in the browser ─
-- Funnel, plan distribution, top users, cohort retention and the 90-day grade
-- volume trend all genuinely need rows — which is exactly why shipping the rows
-- to the client was the wrong answer: the client believed it was aggregating
-- everything while receiving whatever PostgREST chose to return. Aggregating
-- here returns the same shapes with none of the ambiguity.
create or replace function public.admin_platform_analytics(
  p_volume_edges timestamptz[],
  p_cohort_months int default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  edge_count int := coalesce(array_length(p_volume_edges, 1), 0);
  months int := greatest(1, coalesce(p_cohort_months, 6));
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'admin_platform_analytics: admin role required'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    -- Each funnel stage counts DISTINCT users, matching what the client's Sets
    -- did. A plain count(*) over submissions would inflate every stage past the
    -- first for anyone who submitted twice.
    'funnel', jsonb_build_object(
      'signedUp', (select count(*) from public.users),
      'firstSubmission', (select count(distinct user_id) from public.submissions),
      'completedGrade', (
        select count(distinct user_id) from public.submissions
        where status = 'completed'
      ),
      'subscribed', (select count(*) from public.users where plan <> 'free')
    ),

    'planDistribution', coalesce((
      select jsonb_object_agg(p.plan, p.cnt)
      from (
        select plan::text as plan, count(*)::int as cnt
        from public.users group by plan
      ) p
    ), '{}'::jsonb),

    'topUsers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.user_id,
        'name', coalesce(nullif(u.full_name, ''), u.email, 'Unknown user'),
        'plan', coalesce(u.plan::text, 'free'),
        'count', t.cnt
      ) order by t.cnt desc)
      from (
        select user_id, count(*)::int as cnt
        from public.submissions
        group by user_id
        order by cnt desc
        limit 10
      ) t
      left join public.users u on u.id = t.user_id
    ), '[]'::jsonb),

    'gradeVolume', case when edge_count < 2 then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'start', b.start_at,
        'count', (
          select count(*) from public.grade_reports gr
          where gr.created_at >= b.start_at and gr.created_at < b.end_at
        )
      ) order by b.idx)
      from (
        select g.i as idx,
               p_volume_edges[g.i] as start_at,
               p_volume_edges[g.i + 1] as end_at
        from generate_series(1, edge_count - 1) as g(i)
      ) b
    ), '[]'::jsonb) end,

    -- Monthly signup cohorts, most recent `months` of them, each measured
    -- across `months` offsets. A cell is NULL — not 0 — when the month has not
    -- happened yet, so an unreached month reads as blank rather than as total
    -- churn.
    'cohorts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', to_char(c.m, 'YYYY-MM'),
        'size', c.size,
        'retention', c.retention
      ) order by c.m)
      from (
        select
          m.m,
          m.size,
          (
            select jsonb_agg(
              case
                when m.m + make_interval(months => o.i) > date_trunc('month', now())
                  then null
                when m.size = 0 then to_jsonb(0::numeric)
                else to_jsonb(round(
                  100.0 * (
                    select count(distinct s.user_id)
                    from public.submissions s
                    join public.users u2 on u2.id = s.user_id
                    where date_trunc('month', u2.created_at) = m.m
                      and date_trunc('month', s.created_at)
                          = m.m + make_interval(months => o.i)
                  )::numeric / m.size,
                  1))
              end
              order by o.i
            )
            from generate_series(0, months - 1) as o(i)
          ) as retention
        from (
          select date_trunc('month', created_at) as m, count(*)::int as size
          from public.users
          group by 1
          order by 1 desc
          limit months
        ) m
      ) c
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

comment on function public.admin_platform_analytics(timestamptz[], int) is
  'US-2390: funnel, plan mix, top users, cohort retention and the grade-volume '
  'trend for the admin analytics tab, aggregated in SQL instead of shipping '
  'every user/submission/report row to the browser. '
  'SECURITY DEFINER + service_role/is_admin() guard.';

grant execute on function public.admin_platform_analytics(timestamptz[], int) to authenticated;
grant execute on function public.admin_platform_analytics(timestamptz[], int) to service_role;

insert into public.applied_migrations (version) values ('00513') on conflict do nothing;
