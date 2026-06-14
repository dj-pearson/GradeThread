-- US-907: Product funnel & retention analytics.
--
-- Two read-only, SERVER-SIDE aggregations so operators can see where users drop
-- off in the activation flow and whether weekly cohorts keep coming back —
-- without exporting to a BI tool. Both complement (do NOT replace) PostHog's
-- event-level product analytics: these are derived from our own canonical
-- relational data (users / submissions / grade_reports / subscription columns),
-- so they reconcile exactly with the rest of the admin panel.
--
-- ── funnel_metrics(start, end) — activation funnel for a signup cohort ──
-- The cohort is every user who SIGNED UP within [start, end). Each subsequent
-- step is measured to-date and is a STRICT SUBSET of the prior step (a user is
-- only counted at step N if they also completed every earlier step), so the
-- counts are monotonically non-increasing and the step-to-step deltas are real
-- drop-off. The four steps:
--   1. Signed up        — created an account in the window (the cohort).
--   2. First submission — has created >= 1 submission (any time since signup).
--   3. First grade report — has >= 1 completed grade report (the "paid grade":
--      a submission that was actually graded by the AI). Sourced from
--      grade_reports joined through submissions.
--   4. Subscribed       — ever reached a paid subscription: a Stripe sub id is
--      attached, or a `customer.subscription.created` event to a non-free plan
--      exists for them.
--
-- ── retention_cohorts() — weekly engagement retention grid ──
-- Rows = signup week (the last 12 ISO weeks, Monday-aligned via date_trunc).
-- Columns = weeks since signup (offset W0..W8). A cell is the count of that
-- cohort's users who created >= 1 submission in that calendar week (submission =
-- the core engagement signal). Cells for weeks that haven't started yet are null
-- (the client renders them blank, not 0%). W0 is the signup week itself and is
-- NOT forced to 100% — it reflects who actually engaged that first week.
--
-- Access: both are SECURITY DEFINER (they read cross-tenant data, so they can't
-- run under the caller's RLS). The guard mirrors the admin-RPC convention used
-- by revenue_dashboard (00215): an authenticated end-user must be an admin; a
-- call with no JWT subject (service_role — the admin edge route, which already
-- enforced admin + AAL2 in middleware) is allowed; anon is never granted execute.

-- ══════════════════════════════════════════════════════════
-- funnel_metrics(start, end)
-- ══════════════════════════════════════════════════════════
create or replace function public.funnel_metrics(
  p_start timestamptz,
  p_end   timestamptz
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
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'funnel_metrics: admin role required'
      using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'funnel_metrics: invalid period window (start must precede end)'
      using errcode = '22023';
  end if;

  with cohort as (
    select
      u.id,
      exists (
        select 1 from public.submissions s where s.user_id = u.id
      ) as has_submission,
      exists (
        select 1
        from public.grade_reports gr
        join public.submissions s on s.id = gr.submission_id
        where s.user_id = u.id
      ) as has_grade,
      (
        u.flipdesk_subscription_id is not null
        or exists (
          select 1
          from public.flipdesk_subscription_events e
          where e.user_id = u.id
            and e.event_type = 'customer.subscription.created'
            and e.to_plan is not null
            and e.to_plan::text <> 'free'
        )
      ) as has_subscription
    from public.users u
    where u.created_at >= p_start and u.created_at < p_end
  ),
  agg as (
    select
      count(*)::int as signed_up,
      count(*) filter (where has_submission)::int as submitted,
      count(*) filter (where has_submission and has_grade)::int as graded,
      count(*) filter (
        where has_submission and has_grade and has_subscription
      )::int as subscribed
    from cohort
  )
  select jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'steps', jsonb_build_array(
      jsonb_build_object(
        'key', 'signed_up',
        'label', 'Signed up',
        'description', 'Created an account in this period.',
        'count', signed_up
      ),
      jsonb_build_object(
        'key', 'submitted',
        'label', 'First submission',
        'description', 'Started >= 1 garment submission.',
        'count', submitted
      ),
      jsonb_build_object(
        'key', 'graded',
        'label', 'First grade report',
        'description', 'Received >= 1 completed AI condition grade.',
        'count', graded
      ),
      jsonb_build_object(
        'key', 'subscribed',
        'label', 'Subscribed',
        'description', 'Reached a paid subscription.',
        'count', subscribed
      )
    )
  )
  into result
  from agg;

  return result;
end;
$$;

comment on function public.funnel_metrics(timestamptz, timestamptz) is
  'US-907: activation funnel (signup -> first submission -> first grade report '
  '-> subscription) for the signup cohort in [start, end). Each step is a strict '
  'subset of the prior, so deltas are real drop-off. SECURITY DEFINER '
  '(cross-tenant); admin or service-role only.';

grant execute on function public.funnel_metrics(timestamptz, timestamptz) to authenticated;
grant execute on function public.funnel_metrics(timestamptz, timestamptz) to service_role;

-- ══════════════════════════════════════════════════════════
-- retention_cohorts()
-- ══════════════════════════════════════════════════════════
create or replace function public.retention_cohorts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  v_now  timestamptz := now();
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'retention_cohorts: admin role required'
      using errcode = '42501';
  end if;

  with cohorts as (
    -- One row per user in the last 12 weekly cohorts, tagged with their
    -- Monday-aligned signup week.
    select
      u.id,
      date_trunc('week', u.created_at) as cohort_week
    from public.users u
    where u.created_at >= date_trunc('week', v_now) - interval '11 weeks'
  ),
  sizes as (
    select cohort_week, count(*)::int as size
    from cohorts
    group by cohort_week
  ),
  -- Each (user, activity-week-offset) the user submitted in, relative to their
  -- cohort week. distinct so multiple submissions in a week count once.
  activity as (
    select distinct
      c.cohort_week,
      c.id,
      (
        extract(epoch from (date_trunc('week', s.created_at) - c.cohort_week))
        / (7 * 24 * 3600)
      )::int as offset_weeks
    from cohorts c
    join public.submissions s on s.user_id = c.id
    where s.created_at >= c.cohort_week
  ),
  -- Full grid: every cohort week x offsets 0..8. retained is null when the
  -- target week is still in the future (so the client renders it blank).
  grid as (
    select
      sz.cohort_week,
      o.off,
      (sz.cohort_week + (o.off || ' weeks')::interval) as week_start
    from sizes sz
    cross join generate_series(0, 8) as o(off)
  ),
  cells as (
    select
      g.cohort_week,
      g.off,
      case
        when g.week_start <= v_now then coalesce((
          select count(distinct a.id)::int
          from activity a
          where a.cohort_week = g.cohort_week and a.offset_weeks = g.off
        ), 0)
        else null
      end as cnt
    from grid g
  ),
  per_cohort as (
    select
      c.cohort_week,
      sz.size,
      jsonb_agg(c.cnt order by c.off) as retained
    from cells c
    join sizes sz on sz.cohort_week = c.cohort_week
    group by c.cohort_week, sz.size
  )
  select jsonb_build_object(
    'generatedAt', v_now,
    'maxOffset', 8,
    'activitySignal', 'submission',
    'cohorts', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'cohortWeek', cohort_week,
          'size', size,
          'retained', retained
        )
        order by cohort_week desc
      ),
      '[]'::jsonb
    )
  )
  into result
  from per_cohort;

  return result;
end;
$$;

comment on function public.retention_cohorts() is
  'US-907: weekly signup-cohort retention grid for the last 12 weeks. Cell = '
  'count of the cohort active (>= 1 submission) in week-offset W0..W8; future '
  'weeks are null. SECURITY DEFINER (cross-tenant); admin or service-role only.';

grant execute on function public.retention_cohorts() to authenticated;
grant execute on function public.retention_cohorts() to service_role;
