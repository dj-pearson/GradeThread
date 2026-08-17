-- US-2282: four analytics functions answer an ANONYMOUS caller. Close them.
--
-- ⚠ THIS IS LIVE, MEASURED AGAINST PRODUCTION 2026-08-17, with nothing but the
-- public anon key that ships in the browser bundle:
--
--   POST /rest/v1/rpc/ai_spend           -> 200, real per-feature spend in USD
--   POST /rest/v1/rpc/ai_profitability   -> 200, totals and monthly projection
--   POST /rest/v1/rpc/retention_cohorts  -> 200, cohort sizes and retention
--   POST /rest/v1/rpc/funnel_metrics     -> 200, signup funnel counts
--   POST /rest/v1/rpc/ai_budget_status   -> 200, budget rows and spend pct
--   POST /rest/v1/rpc/reconciliation_candidates -> 200, and this one returns
--       USER EMAIL ADDRESSES alongside subject user ids. That is personal data,
--       not a metric, and it is the reason this migration is not "analytics".
--
-- Not zeros. Real numbers, and one real mailbox.
--
-- SIX, NOT FOUR. The story named four. A query for the guard's exact shape
-- across every live SECURITY DEFINER function found two more that nobody had
-- listed — which is the argument for matching on the DEFECT rather than working
-- from a list somebody wrote by hand.
--
-- ── THE BUG IS THE GUARD, NOT A MISSING ONE ─────────────────────────────────
--
-- All four already had an authorization check, which is why this survived
-- review. It reads:
--
--     if auth.uid() is not null and not public.is_admin() then
--       raise exception '…: admin role required' using errcode = '42501';
--     end if;
--
-- An ANONYMOUS caller has no auth.uid(). The condition is therefore false, no
-- exception is raised, and the function returns its document. The check only
-- ever constrained users who were signed IN — precisely the population that is
-- least likely to be the attacker.
--
-- It is the identical defect found in revenue_dashboard and fixed by 00610.
-- There, an unrelated 42703 was masking it; here nothing was, so these four have
-- been answering the public key for as long as they have existed.
--
-- ── THE FIX IS AN ALLOWLIST, AND IT IS ALREADY PROVEN IN PRODUCTION ──────────
--
--     if not (auth.role() = 'service_role' or public.is_admin()) then
--
-- A positive test: you are the service role, or you are an admin, or you are
-- refused. `admin_revenue_metrics` has used it since it was written, and
-- revenue_dashboard has since 00610 — measured on prod today, that one answers
-- HTTP 401 / 42501 to the same anon call these four answer with data. That is
-- the control, on the same database, minutes apart.
--
-- Every real caller is the SERVICE ROLE and keeps working:
--   ai_spend                   routes/admin-ai-spend.ts:48              supabaseAdmin.rpc
--   ai_profitability           lib/agent-tools.ts:1696                  ctx.io.rpc
--   funnel_metrics             lib/agent-tools.ts:1143                  supabaseAdmin.rpc
--   retention_cohorts          routes/admin-analytics.ts:73             supabaseAdmin.rpc
--   ai_budget_status           lib/agent-tools.ts:1540                  ctx.io.rpc
--   reconciliation_candidates  routes/jobs-billing-reconciliation.ts:178 supabaseAdmin.rpc
--
-- ── WHY NO REVOKE, AGAIN ────────────────────────────────────────────────────
--
-- Tightening the GRANT is the obvious-looking fix and is not available. A
-- DENIED call from anon or authenticated SEGFAULTS this Postgres image
-- (US-2403), which is why 00527 is a permanent DO NOT APPLY — an owner
-- decision. A body check raises an ordinary error instead, so it arms nothing.
-- And per US-2666 a `REVOKE … FROM anon` would be a no-op anyway: the
-- CREATE FUNCTION grant to PUBLIC survives it.
--
-- Everything below is the live definition of each function carried through
-- byte-for-byte with ONLY that one line replaced. CREATE OR REPLACE, unchanged
-- signatures, so there is no overload to strip and no window where a function
-- is missing.

-- ── ai_spend ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_spend(p_period text DEFAULT '30d'::text, p_group_by text DEFAULT 'feature'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_period       text := lower(coalesce(p_period, '30d'));
  v_group        text := lower(coalesce(p_group_by, 'feature'));
  v_days         int;
  v_window_start timestamptz;
  v_series_start timestamptz;
  result         jsonb;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'ai_spend: admin role required' using errcode = '42501';
  end if;

  if v_period not in ('today', '7d', '30d', '90d') then v_period := '30d'; end if;
  if v_group  not in ('model', 'feature', 'day')   then v_group  := 'feature'; end if;

  v_days := case v_period
              when 'today' then 1 when '7d' then 7 when '30d' then 30 when '90d' then 90
              else 30 end;
  v_window_start := case
    when v_period = 'today' then date_trunc('day', now())
    else now() - make_interval(days => v_days)
  end;
  v_series_start := date_trunc('day', v_window_start);

  with prices as (
    select coalesce(
      (select value from public.system_settings where key = 'ai_model_prices'),
      '{}'::jsonb
    ) as p
  ),
  priced as (
    -- Re-price each raw event from the CURRENT config rates. Unknown model →
    -- 0 cost (tokens still counted, so the model is visible, not hidden). Span
    -- back to yesterday even when the window is shorter, so the day-delta works.
    select
      e.created_at,
      e.feature,
      e.model,
      e.input_tokens,
      e.output_tokens,
      e.cache_creation_tokens,
      e.cache_read_tokens,
      (
          e.input_tokens          * coalesce((pr.p -> e.model ->> 'input')::numeric, 0)
        + e.output_tokens         * coalesce((pr.p -> e.model ->> 'output')::numeric, 0)
        + e.cache_creation_tokens * coalesce((pr.p -> e.model ->> 'cache_write')::numeric, 0)
        + e.cache_read_tokens     * coalesce((pr.p -> e.model ->> 'cache_read')::numeric, 0)
      ) / 1000000.0 as est_cost
    from public.ai_usage_events e
    cross join prices pr
    where e.created_at >= least(v_window_start, date_trunc('day', now()) - interval '1 day')
  )
  select jsonb_build_object(
    'period', v_period,
    'groupBy', v_group,
    'windowStart', v_window_start,
    'generatedAt', now(),
    'pricedFrom', 'system_settings.ai_model_prices',
    'totals', (
      select jsonb_build_object(
        'costUsd', coalesce(sum(est_cost), 0),
        'calls', count(*)::bigint,
        'inputTokens', coalesce(sum(input_tokens), 0)::bigint,
        'outputTokens', coalesce(sum(output_tokens), 0)::bigint,
        'cacheCreationTokens', coalesce(sum(cache_creation_tokens), 0)::bigint,
        'cacheReadTokens', coalesce(sum(cache_read_tokens), 0)::bigint
      )
      from priced where created_at >= v_window_start
    ),
    -- Breakdown by the requested dimension, biggest spender first.
    'rows', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', key,
        'costUsd', cost,
        'calls', calls,
        'inputTokens', in_tok,
        'outputTokens', out_tok
      ) order by cost desc), '[]'::jsonb)
      from (
        select
          case v_group
            when 'model' then model
            when 'day'   then to_char(date_trunc('day', created_at), 'YYYY-MM-DD')
            else feature
          end as key,
          sum(est_cost)              as cost,
          count(*)::bigint           as calls,
          sum(input_tokens)::bigint  as in_tok,
          sum(output_tokens)::bigint as out_tok
        from priced
        where created_at >= v_window_start
        group by 1
      ) g
    ),
    -- Daily series across the whole window (zero-filled) for the chart.
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'day', to_char(d.day, 'YYYY-MM-DD'),
        'costUsd', coalesce(agg.cost, 0),
        'calls', coalesce(agg.calls, 0),
        'inputTokens', coalesce(agg.in_tok, 0),
        'outputTokens', coalesce(agg.out_tok, 0)
      ) order by d.day), '[]'::jsonb)
      from generate_series(v_series_start, date_trunc('day', now()), interval '1 day') as d(day)
      left join lateral (
        select
          sum(est_cost)              as cost,
          count(*)::bigint           as calls,
          sum(input_tokens)::bigint  as in_tok,
          sum(output_tokens)::bigint as out_tok
        from priced p
        where p.created_at >= d.day and p.created_at < d.day + interval '1 day'
      ) agg on true
    ),
    -- Top spending features TODAY (AC4).
    'topFeaturesToday', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'feature', feature, 'costUsd', cost, 'calls', calls
      ) order by cost desc), '[]'::jsonb)
      from (
        select feature, sum(est_cost) as cost, count(*)::bigint as calls
        from priced
        where created_at >= date_trunc('day', now())
        group by feature
      ) t
    ),
    -- Today vs yesterday spend (AC4) — the client renders the delta.
    'todayCostUsd', (
      select coalesce(sum(est_cost), 0)
      from priced where created_at >= date_trunc('day', now())
    ),
    'yesterdayCostUsd', (
      select coalesce(sum(est_cost), 0)
      from priced
      where created_at >= date_trunc('day', now()) - interval '1 day'
        and created_at <  date_trunc('day', now())
    )
  ) into result;

  return result;
end;
$function$;

-- ── ai_profitability ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_profitability(p_period text DEFAULT '30d'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_period       text := lower(coalesce(p_period, '30d'));
  v_days         int;
  v_window_start timestamptz;
  v_econ         jsonb;
  v_scenarios    jsonb;
  result         jsonb;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'ai_profitability: admin role required' using errcode = '42501';
  end if;

  if v_period not in ('today', '7d', '30d', '90d') then v_period := '30d'; end if;
  v_days := case v_period when 'today' then 1 when '7d' then 7 when '30d' then 30 when '90d' then 90 else 30 end;
  v_window_start := case
    when v_period = 'today' then date_trunc('day', now())
    else now() - make_interval(days => v_days)
  end;

  v_econ := coalesce(
    (select value from public.system_settings where key = 'ai_feature_economics'),
    '{}'::jsonb);
  v_scenarios := coalesce(
    (select value from public.system_settings where key = 'ai_usage_scenarios'),
    '[]'::jsonb);

  with prices as (
    select coalesce(
      (select value from public.system_settings where key = 'ai_model_prices'),
      '{}'::jsonb) as p
  ),
  -- Re-price each ledger event from the CURRENT rate table (same basis as ai_spend).
  priced as (
    select
      e.feature,
      e.submission_id,
      e.input_tokens,
      e.output_tokens,
      (
          e.input_tokens          * coalesce((pr.p -> e.model ->> 'input')::numeric, 0)
        + e.output_tokens         * coalesce((pr.p -> e.model ->> 'output')::numeric, 0)
        + e.cache_creation_tokens * coalesce((pr.p -> e.model ->> 'cache_write')::numeric, 0)
        + e.cache_read_tokens     * coalesce((pr.p -> e.model ->> 'cache_read')::numeric, 0)
      ) / 1000000.0 as est_cost
    from public.ai_usage_events e
    cross join prices pr
    where e.created_at >= v_window_start
  ),
  agg as (
    select
      feature,
      sum(est_cost)                    as cost,
      count(*)::bigint                 as calls,
      count(distinct submission_id)    as distinct_subs,
      sum(input_tokens)::bigint        as in_tok,
      sum(output_tokens)::bigint       as out_tok
    from priced
    group by feature
  ),
  -- Every configured feature UNION any feature seen in the ledger but not yet
  -- configured (so nothing is hidden), each joined to its rollup.
  feat_keys as (
    select k as feature from jsonb_object_keys(v_econ) as k
    union
    select feature from agg
  ),
  cpa as (
    select
      fk.feature,
      coalesce(v_econ -> fk.feature ->> 'action_unit', 'call') as action_unit,
      a.cost, a.calls, a.distinct_subs, a.in_tok, a.out_tok,
      case when coalesce(v_econ -> fk.feature ->> 'action_unit', 'call') = 'submission'
           then a.distinct_subs else a.calls end as actions
    from feat_keys fk
    left join agg a on a.feature = fk.feature
  )
  select jsonb_build_object(
    'period', v_period,
    'windowStart', v_window_start,
    'generatedAt', now(),
    'pricedFrom', 'system_settings.ai_model_prices',
    'projectionBasis', 'Per-feature monthly spend = run-rate of the selected window scaled to 30 days; scenarios use observed per-action cost where the ledger has data, else the modeled fallback.',
    'features', (
      select coalesce(jsonb_agg(obj order by ord_cost desc nulls last, feat), '[]'::jsonb)
      from (
        select
          c.feature as feat,
          coalesce(c.cost, 0) as ord_cost,
          jsonb_build_object(
            'feature', c.feature,
            'label', coalesce(v_econ -> c.feature ->> 'label', initcap(replace(c.feature, '_', ' '))),
            'currentModel', v_econ -> c.feature ->> 'current_model',
            'recommendedModel', v_econ -> c.feature ->> 'recommended_model',
            'qualityNote', v_econ -> c.feature ->> 'quality_note',
            'actionUnit', c.action_unit,
            'revenueBasis', coalesce(v_econ -> c.feature ->> 'revenue_basis', 'none'),
            'costUsd', round(coalesce(c.cost, 0)::numeric, 6),
            'calls', coalesce(c.calls, 0),
            'actions', coalesce(c.actions, 0),
            'inputTokens', coalesce(c.in_tok, 0),
            'outputTokens', coalesce(c.out_tok, 0),
            'avgInputTokens', case when coalesce(c.calls, 0) > 0 then round((c.in_tok::numeric) / c.calls, 0) else 0 end,
            'avgOutputTokens', case when coalesce(c.calls, 0) > 0 then round((c.out_tok::numeric) / c.calls, 0) else 0 end,
            'costPerCallUsd', case when coalesce(c.calls, 0) > 0 then round((c.cost / c.calls)::numeric, 6) else null end,
            'costPerActionUsd', case when coalesce(c.actions, 0) > 0 then round((c.cost / c.actions)::numeric, 6) else null end,
            'revenuePerActionUsd', (v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric,
            'subscriptionRefUsd', (v_econ -> c.feature ->> 'subscription_ref_usd')::numeric,
            'grossMarginPerActionUsd', case
              when coalesce(v_econ -> c.feature ->> 'revenue_basis', 'none') = 'per_action'
                and (v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric is not null
                and coalesce(c.actions, 0) > 0
              then round(((v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric - c.cost / c.actions)::numeric, 6)
              else null end,
            'grossMarginPct', case
              when coalesce(v_econ -> c.feature ->> 'revenue_basis', 'none') = 'per_action'
                and (v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric > 0
                and coalesce(c.actions, 0) > 0
              then round(((((v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric - c.cost / c.actions)
                          / (v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric) * 100)::numeric, 2)
              else null end,
            'costRevenueRatio', case
              when (v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric > 0 and coalesce(c.actions, 0) > 0
              then round(((c.cost / c.actions) / (v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric)::numeric, 4)
              else null end,
            'monthlyProjectedCostUsd', round((coalesce(c.cost, 0) * 30.0 / v_days)::numeric, 4),
            'breakEvenActionsPerMonth', case
              when (v_econ -> c.feature ->> 'subscription_ref_usd')::numeric > 0
                and coalesce(c.actions, 0) > 0 and c.cost > 0
              then round(((v_econ -> c.feature ->> 'subscription_ref_usd')::numeric / (c.cost / c.actions))::numeric, 0)
              else null end,
            'flag', case
              when coalesce(c.actions, 0) = 0 then 'no_data'
              when coalesce(v_econ -> c.feature ->> 'revenue_basis', 'none') = 'per_action'
                and (v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric > 0 then
                case
                  when (c.cost / c.actions) / (v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric >= 0.5 then 'at_risk'
                  when (c.cost / c.actions) / (v_econ -> c.feature ->> 'revenue_per_action_usd')::numeric >= 0.2 then 'watch'
                  else 'healthy'
                end
              when coalesce(v_econ -> c.feature ->> 'revenue_basis', 'none') = 'subscription' then 'subscription'
              else 'tracked'
            end
          ) as obj
        from cpa c
      ) f
    ),
    'totals', (
      select jsonb_build_object(
        'costUsd', round(coalesce(sum(cost), 0)::numeric, 6),
        'calls', coalesce(sum(calls), 0)::bigint,
        'monthlyProjectedCostUsd', round((coalesce(sum(cost), 0) * 30.0 / v_days)::numeric, 4)
      )
      from agg
    ),
    -- Project each modeled scenario: monthly spend (observed-or-fallback CPA ×
    -- modeled volume) vs modeled revenue, with a per-feature breakdown.
    'scenarios', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'key', s.value ->> 'key',
          'label', s.value ->> 'label',
          'description', s.value ->> 'description',
          'monthlyRevenueUsd', coalesce((s.value ->> 'monthly_revenue_usd')::numeric, 0),
          'monthlySpendUsd', round(coalesce(spend.total, 0)::numeric, 2),
          'monthlyMarginUsd', round((coalesce((s.value ->> 'monthly_revenue_usd')::numeric, 0) - coalesce(spend.total, 0))::numeric, 2),
          'monthlyMarginPct', case
            when coalesce((s.value ->> 'monthly_revenue_usd')::numeric, 0) > 0
            then round((((coalesce((s.value ->> 'monthly_revenue_usd')::numeric, 0) - coalesce(spend.total, 0))
                        / (s.value ->> 'monthly_revenue_usd')::numeric) * 100)::numeric, 1)
            else null end,
          'perFeature', coalesce(spend.per_feature, '[]'::jsonb)
        ) order by s.ord
      ), '[]'::jsonb)
      from jsonb_array_elements(v_scenarios) with ordinality as s(value, ord)
      cross join lateral (
        select
          sum(line.spend) as total,
          jsonb_agg(jsonb_build_object(
            'feature', line.feature,
            'label', coalesce(v_econ -> line.feature ->> 'label', initcap(replace(line.feature, '_', ' '))),
            'monthlyActions', line.actions,
            'costPerActionUsd', round(line.cpa::numeric, 6),
            'costSource', line.source,
            'monthlySpendUsd', round(line.spend::numeric, 2)
          ) order by line.spend desc) as per_feature
        from (
          select
            vol.feature,
            vol.cnt as actions,
            coalesce(obs.cpa, (v_econ -> vol.feature ->> 'fallback_cost_per_action_usd')::numeric, 0) as cpa,
            case when obs.cpa is not null then 'observed' else 'modeled' end as source,
            vol.cnt * coalesce(obs.cpa, (v_econ -> vol.feature ->> 'fallback_cost_per_action_usd')::numeric, 0) as spend
          from (
            select kv.k as feature, (kv.v)::numeric as cnt
            from jsonb_each_text(coalesce(s.value -> 'volumes', '{}'::jsonb)) as kv(k, v)
          ) vol
          left join lateral (
            select case when c.actions > 0 then c.cost / c.actions else null end as cpa
            from cpa c where c.feature = vol.feature
          ) obs on true
        ) line
      ) spend
    )
  ) into result;

  return result;
end;
$function$;

-- ── funnel_metrics ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.funnel_metrics(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result jsonb;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
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
$function$;

-- ── retention_cohorts ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.retention_cohorts()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result jsonb;
  v_now  timestamptz := now();
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
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
$function$;

-- ── ai_budget_status ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_budget_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result jsonb;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'ai_budget_status: admin role required' using errcode = '42501';
  end if;

  with prices as (
    select coalesce(
      (select value from public.system_settings where key = 'ai_model_prices'),
      '{}'::jsonb
    ) as p
  ),
  priced as (
    -- Re-price each event since the start of the month (the widest window any
    -- budget needs); the per-budget lateral filters to its own window below.
    select
      e.feature,
      e.created_at,
      (
          e.input_tokens          * coalesce((pr.p -> e.model ->> 'input')::numeric, 0)
        + e.output_tokens         * coalesce((pr.p -> e.model ->> 'output')::numeric, 0)
        + e.cache_creation_tokens * coalesce((pr.p -> e.model ->> 'cache_write')::numeric, 0)
        + e.cache_read_tokens     * coalesce((pr.p -> e.model ->> 'cache_read')::numeric, 0)
      ) / 1000000.0 as est_cost
    from public.ai_usage_events e
    cross join prices pr
    where e.created_at >= date_trunc('month', now())
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id,
    'feature', b.feature,
    'period', b.period,
    'limitUsd', b.limit_usd,
    'action', b.action,
    'enabled', b.enabled,
    'spendUsd', round(coalesce(s.spend, 0)::numeric, 4),
    'breached', coalesce(s.spend, 0) >= b.limit_usd,
    'pct', case when b.limit_usd > 0
                then round((coalesce(s.spend, 0) / b.limit_usd * 100)::numeric, 1)
                else 0 end,
    'updatedAt', b.updated_at
  ) order by b.feature, b.period), '[]'::jsonb)
  into result
  from public.ai_budgets b
  left join lateral (
    select sum(p.est_cost) as spend
    from priced p
    where p.feature = b.feature
      and p.created_at >= case b.period
                            when 'day'   then date_trunc('day', now())
                            else              date_trunc('month', now())
                          end
  ) s on true;

  return coalesce(result, '[]'::jsonb);
end;
$function$;

-- ── reconciliation_candidates ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconciliation_candidates(p_limit integer DEFAULT 2000)
 RETURNS TABLE(subject_user_id uuid, email text, db_status text, db_plan text, past_due_since timestamp with time zone, stripe_customer_id text, subscription_id text, latest_event_id uuid, latest_event_type text, event_to_plan text, event_raw_status text, event_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Authenticated end-users must be admins; the service-role job (auth.uid()
  -- null) passes. anon can't reach this — execute is not granted to it.
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'reconciliation_candidates: admin role required'
      using errcode = '42501';
  end if;

  return query
  select
    latest.user_id,
    u.email,
    u.subscription_status::text,
    u.flipdesk_plan::text,
    u.past_due_since,
    u.stripe_customer_id,
    u.flipdesk_subscription_id,
    latest.id,
    latest.event_type,
    latest.to_plan::text,
    latest.raw_payload->>'status',
    latest.created_at
  from (
    select distinct on (e.user_id)
      e.user_id, e.id, e.event_type, e.to_plan, e.raw_payload, e.created_at
    from public.flipdesk_subscription_events e
    order by e.user_id, e.created_at desc
  ) latest
  join public.users u on u.id = latest.user_id
  order by latest.created_at desc
  limit greatest(1, least(coalesce(p_limit, 2000), 10000));
end;
$function$;


-- ── Prove it actually took effect (added after 00611 did not) ───────────────
--
-- CREATE OR REPLACE only replaces a function with the SAME argument list. A
-- different signature creates a SECOND OVERLOAD and leaves the original live —
-- and the original is what PostgREST keeps routing to. That produces a
-- migration recorded as applied whose behaviour never changed, which is worse
-- than a failure because the record is what everyone trusts afterwards.
--
-- This block asserts the effect BEFORE the footer records the version. Under
-- ON_ERROR_STOP=1 the raise aborts the run and nothing is recorded; without it,
-- the operator still gets a loud error naming the exact signature at fault.
do $verify_00611$
declare
  unguarded text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into unguarded
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('ai_spend', 'ai_profitability', 'funnel_metrics', 'retention_cohorts', 'ai_budget_status', 'reconciliation_candidates')
    and p.prosrc not like '%auth.role()%';

  if unguarded is not null then
    raise exception
      '00611 did NOT take effect for: %. CREATE OR REPLACE only replaces a matching signature; a different one creates an OVERLOAD and leaves the original live. Compare these against the CREATE statements above.',
      unguarded
      using errcode = 'check_violation';
  end if;
end
$verify_00611$;

insert into public.applied_migrations (version) values ('00611') on conflict do nothing;
