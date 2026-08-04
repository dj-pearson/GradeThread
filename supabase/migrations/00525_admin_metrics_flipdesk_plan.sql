-- 00525: admin metrics read flipdesk_plan, not the frozen users.plan (US-2398).
--
-- users.plan has not been written since the 00039 backfill: no update in the
-- edge service, no SET in any migration. 00001 defines it NOT NULL DEFAULT
-- 'free', so every account created since carries the default and every account
-- that changed tier since carries whatever the backfill left.
--
-- Four metrics read it, and two of them are business numbers an operator acts
-- on: totalPaid (count where plan <> 'free') and churnFreeWithActivity (the
-- churn NUMERATOR). Both errors run the SAME direction -- fewer paying users,
-- more churn -- so the dashboard told a consistent story about a business doing
-- worse than it is. A number that is obviously broken gets questioned; a
-- plausible one does not.
--
-- MRR was never affected: 00215 prices it by joining pricing_plans on
-- flipdesk_plan. That is exactly why this went unnoticed -- the headline figure
-- was right while the counts beside it were not.
--
-- ⚠ THE VOCABULARY CHANGES, deliberately (US-2398 AC2). users.plan is
-- public.user_plan ('free','starter','professional','enterprise');
-- flipdesk_plan is ('free','starter','pro','business'). A count of <> 'free'
-- needs no mapping. planDistribution and the topUsers badge now report the
-- CURRENT vocabulary, so 'professional'/'enterprise' stop appearing -- they
-- were never the live tier names, only the frozen ones.
--
-- Both functions are replaced whole (CREATE OR REPLACE) rather than patched,
-- so re-running this file is safe and the definitions stay readable in one
-- place. Only the plan column differs from 00513/00514.

CREATE OR REPLACE FUNCTION public.admin_system_metrics()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result jsonb;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
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
          select flipdesk_plan::text as plan, count(*)::int as cnt
          from public.users group by flipdesk_plan
        ) p
      ),
      'totalPaid', (
        select count(*)::int from public.users where flipdesk_plan <> 'free'
      ),
      -- Estimated 30-day churn: users who signed up >30d ago, are now on free,
      -- and have an own sale in the last 30 days (i.e. were recently active but
      -- not paying). churn% = activeFree / (paid + activeFree).
      'churnFreeWithActivity', (
        select count(distinct u.id)::int
        from public.users u
        where u.flipdesk_plan = 'free'
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
$function$
;

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
      'subscribed', (select count(*) from public.users where flipdesk_plan <> 'free')
    ),

    'planDistribution', coalesce((
      select jsonb_object_agg(p.plan, p.cnt)
      from (
        select flipdesk_plan::text as plan, count(*)::int as cnt
        from public.users group by flipdesk_plan
      ) p
    ), '{}'::jsonb),

    'topUsers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.user_id,
        'name', coalesce(nullif(u.full_name, ''), u.email, 'Unknown user'),
        'plan', coalesce(u.flipdesk_plan::text, 'free'),
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

grant execute on function public.admin_platform_analytics(timestamptz[], int) to authenticated;
grant execute on function public.admin_platform_analytics(timestamptz[], int) to service_role;

-- Self-record so the boot guard stays truthful however this was applied.
insert into public.applied_migrations (version) values ('00525') on conflict do nothing;
