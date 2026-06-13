-- US-583: Trustworthy revenue (MRR/ARPU/churn) + per-grade AI-cost reporting.
--
-- The admin "System Health" page previously derived its financials from
-- heuristics that are wrong as soon as the product has real subscribers:
--   * MRR  = count(users where legacy `plan` <> 'free') × PLANS pricing, with a
--            hard-coded $499/mo estimate for every "enterprise" row. The legacy
--            users.plan column was the OLD conflated tier (pre US-201 split); it
--            is backfilled and slated for removal, and "enterprise" isn't even a
--            current FlipDesk tier — so this counted phantom revenue.
--   * churn = "free user who signed up >30d ago AND has a sale in the last 30d"
--            — a guess about activity, not an actual cancellation.
--   * AI cost = not tracked at all, so gross margin per grade was unknowable.
--
-- This migration adds:
--   1. ai_usage_events — an append-only ledger of every Anthropic call the
--      grading pipeline makes, with token counts and a precomputed USD cost
--      (lib/ai-usage.ts computes cost from the model price table at write time).
--   2. admin_revenue_metrics() — one jsonb document with AUTHORITATIVE numbers:
--      - active paid subscriptions grouped by (flipdesk_plan, interval) from the
--        real subscription columns (subscription_status in active/past_due),
--        returned raw so the client computes MRR from FLIPDESK_PLANS pricing
--        (one source of truth, mirroring admin_system_metrics' plan_counts).
--      - event-based 30-day churn from flipdesk_subscription_events
--        (customer.subscription.deleted), not an activity guess.
--      - AI token spend + cost per day / 24h / 30d and avg cost per grade,
--        aggregated from ai_usage_events.
--
-- SECURITY DEFINER + is_admin() guard, same pattern as migration 00147
-- (admin_system_metrics): the function reads platform-wide cross-tenant data, so
-- it cannot run under the caller's RLS; the guard raises for non-admins.

-- ── 1. ai_usage_events: per-call Anthropic token + cost ledger ──────────────
create table if not exists public.ai_usage_events (
  id                      uuid primary key default gen_random_uuid(),
  -- Nullable + ON DELETE SET NULL so deleting a user/submission never blocks on
  -- (and never deletes) the historical cost record used for margin reporting.
  user_id                 uuid references public.users(id) on delete set null,
  submission_id           uuid references public.submissions(id) on delete set null,
  -- 'per_image' | 'composite' (extensible). One row per Anthropic call so a
  -- grade made of N per-image calls + 1 composite call = N+1 rows, all sharing
  -- submission_id (per-grade cost = sum over submission_id).
  phase                   text not null,
  model                   text not null,
  input_tokens            integer not null default 0 check (input_tokens >= 0),
  output_tokens           integer not null default 0 check (output_tokens >= 0),
  cache_creation_tokens   integer not null default 0 check (cache_creation_tokens >= 0),
  cache_read_tokens       integer not null default 0 check (cache_read_tokens >= 0),
  -- USD cost computed at write time from the model price table (lib/ai-usage.ts).
  -- Stored so the dashboard never needs the price table; numeric keeps fractions
  -- of a cent exact across millions of rows.
  cost_usd                numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at              timestamptz not null default now()
);

create index if not exists idx_ai_usage_events_created_at
  on public.ai_usage_events(created_at desc);

create index if not exists idx_ai_usage_events_submission_id
  on public.ai_usage_events(submission_id)
  where submission_id is not null;

alter table public.ai_usage_events enable row level security;
-- No user-facing policy: written by the service-role grading pipeline, read only
-- by admins through the SECURITY DEFINER RPC below. RLS-on with no policy means
-- the anon/authenticated roles can't read it directly.

comment on table public.ai_usage_events is
  'US-583: append-only ledger of Anthropic API usage per grading call '
  '(token counts + precomputed USD cost). Powers per-grade AI gross-margin.';

-- ── 2. admin_revenue_metrics(): authoritative revenue + AI cost ────────────
create or replace function public.admin_revenue_metrics()
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
$$;

comment on function public.admin_revenue_metrics() is
  'US-583: authoritative subscription revenue (active paid subs by plan/interval, '
  'event-based churn) + AI token spend / per-grade cost, as one jsonb document. '
  'SECURITY DEFINER + is_admin() guard (reads cross-tenant data).';

grant execute on function public.admin_revenue_metrics() to authenticated;
grant execute on function public.admin_revenue_metrics() to service_role;
