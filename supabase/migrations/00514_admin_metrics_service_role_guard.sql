-- US-2393: let the service-role client through the two admin metrics guards.
--
-- GET /api/admin/dashboard/system calls admin_system_metrics() and
-- admin_revenue_metrics() through supabaseAdmin, the SERVICE-ROLE client. Both
-- guarded with a bare `if not public.is_admin()`, and is_admin() resolves the
-- caller through auth.uid() — which is NULL for a service-role JWT, because it
-- carries no `sub`. So the guard raised 42501 on every call and the route
-- answered 500. Latent since US-1565 moved that page behind the edge admin
-- boundary, which is the change that put a service-role client in front of an
-- is_admin() guard.
--
-- The guard becomes the 00207/00227 pattern. This gives up nothing: the route is
-- already gated by the edge admin middleware (JWT + role + AAL2 + audit), which
-- is precisely what US-1565 moved it there for, and a non-admin authenticated
-- caller is still refused by the is_admin() half.
--
-- The bodies below are pg_get_functiondef() output with ONLY the guard line
-- changed — generated, not retyped, so this cannot smuggle in a behaviour change
-- alongside the fix.
--
-- NOT a blanket change: the OTHER admin functions using is_admin() are already
-- correct and are deliberately untouched. Eight of them
-- (ai_spend, ai_budget_status, ai_profitability, funnel_metrics,
-- reconciliation_candidates, referral_analytics, retention_cohorts,
-- revenue_dashboard) guard with `if auth.uid() is not null and not
-- public.is_admin()`, which already lets a NULL-uid service-role caller
-- through. Two more (admin_user_list_stats, admin_audit_log_filter_options)
-- keep the strict guard on purpose — they are called from the BROWSER by an
-- authenticated admin, where auth.uid() is populated and the strict form is
-- exactly right.

CREATE OR REPLACE FUNCTION public.admin_revenue_metrics()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result jsonb;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'admin_revenue_metrics: admin role required'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'subscriptions', jsonb_build_object(
      -- Genuinely-billing subscriptions: active or past_due (Stripe is still
      -- attempting collection), on a paid FlipDesk tier. trialing is NOT counted
      -- toward MRR (no charge yet) and is surfaced separately.
      'activePaid', (
        select count(*)::int from public.users
        where subscription_status in ('active', 'past_due')
          and flipdesk_plan <> 'free'
      ),
      'trialing', (
        select count(*)::int from public.users
        where subscription_status = 'trialing'
      ),
      'pastDue', (
        select count(*)::int from public.users
        where subscription_status = 'past_due'
      ),
      -- Raw active-subscription counts by (plan, interval) so the client derives
      -- MRR from FLIPDESK_PLANS pricing — pricing stays in one place (constants),
      -- never hard-coded here. Yearly is normalized to monthly client-side.
      'byPlanInterval', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'plan', plan,
          'interval', coalesce(intv, 'monthly'),
          'count', cnt
        )), '[]'::jsonb)
        from (
          select
            flipdesk_plan::text as plan,
            flipdesk_interval as intv,
            count(*)::int as cnt
          from public.users
          where subscription_status in ('active', 'past_due')
            and flipdesk_plan <> 'free'
          group by flipdesk_plan, flipdesk_interval
        ) s
      ),
      -- Authoritative 30-day churn: distinct users whose subscription was
      -- canceled (Stripe customer.subscription.deleted) in the window. Replaces
      -- the old "free user with a recent sale" activity guess.
      'canceledLast30d', (
        select count(distinct user_id)::int
        from public.flipdesk_subscription_events
        where event_type = 'customer.subscription.deleted'
          and created_at >= now() - interval '30 days'
      )
    ),
    'ai', jsonb_build_object(
      -- Whether any cost has been tracked at all — lets the UI show an honest
      -- "no AI-cost data yet" state instead of a misleading $0 margin.
      'costTrackingActive', (
        select exists (select 1 from public.ai_usage_events)
      ),
      'last24h', (
        select jsonb_build_object(
          'costUsd', coalesce(sum(cost_usd), 0),
          'inputTokens', coalesce(sum(input_tokens), 0)::bigint,
          'outputTokens', coalesce(sum(output_tokens), 0)::bigint,
          'grades', count(distinct submission_id)::int
        )
        from public.ai_usage_events
        where created_at >= now() - interval '24 hours'
      ),
      'last30d', (
        select jsonb_build_object(
          'costUsd', coalesce(sum(cost_usd), 0),
          'inputTokens', coalesce(sum(input_tokens), 0)::bigint,
          'outputTokens', coalesce(sum(output_tokens), 0)::bigint,
          'grades', count(distinct submission_id)::int
        )
        from public.ai_usage_events
        where created_at >= now() - interval '30 days'
      ),
      -- Avg AI cost per graded submission over 30d (total cost / distinct grades).
      'avgCostPerGradeUsd', coalesce((
        select sum(cost_usd) / nullif(count(distinct submission_id), 0)
        from public.ai_usage_events
        where created_at >= now() - interval '30 days'
          and submission_id is not null
      ), 0),
      -- Last 30 daily buckets: cost + tokens + grades per day.
      'daily', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'start', b.bucket,
          'costUsd', coalesce(agg.cost, 0),
          'grades', coalesce(agg.grades, 0),
          'inputTokens', coalesce(agg.in_tok, 0)::bigint,
          'outputTokens', coalesce(agg.out_tok, 0)::bigint
        ) order by b.bucket), '[]'::jsonb)
        from generate_series(
          date_trunc('day', now()) - interval '29 days',
          date_trunc('day', now()),
          interval '1 day'
        ) as b(bucket)
        left join lateral (
          select
            sum(e.cost_usd) as cost,
            sum(e.input_tokens) as in_tok,
            sum(e.output_tokens) as out_tok,
            count(distinct e.submission_id) as grades
          from public.ai_usage_events e
          where e.created_at >= b.bucket
            and e.created_at < b.bucket + interval '1 day'
        ) agg on true
      )
    )
  ) into result;

  return result;
end;
$function$
;
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
$function$
;

insert into public.applied_migrations (version) values ('00514') on conflict do nothing;
