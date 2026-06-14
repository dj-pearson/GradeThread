-- US-895: AI cost budget guardrails + auto-throttle.
--
-- Per-feature daily/monthly AI spend budgets that, when exceeded, alert and (for
-- action='kill') automatically flip the matching feature kill-switch off — so a
-- bug or abuse can't run up an unbounded Claude bill. Builds directly on:
--   • ai_usage_events (00163/00218) — the per-call token+cost ledger.
--   • system_settings.ai_model_prices (00218) — the config-driven price table the
--     spend rollup re-prices from (so a budget is measured against the SAME cost
--     basis the AI-spend dashboard shows; AC4).
--   • feature_flags (00096/00210) — the kill-switch the guardrail flips for
--     action='kill', via the existing mechanism (isFeatureEnabled honors it).
--
-- Two tables + one read RPC:
--   1. ai_budgets — operator-editable budgets (feature, period, limit, action).
--   2. ai_budget_breaches — an audit row per breach the scheduled job records,
--      noting whether it auto-killed a flag, with a one-click "resolved" lifecycle
--      (the admin re-enable path flips the flag back on and resolves the breach).
--   3. ai_budget_status() — re-prices ai_usage_events per the current rate table
--      and returns each budget's current period spend + breached flag, for both
--      the scheduled evaluator (lib/ai-budget.ts) and the admin AI-spend page.
--
-- Both tables are OPERATOR data: RLS enabled, NO policy (deny-all), writes revoked
-- from anon/authenticated. They carry no user_id column (only updated_by /
-- resolved_by audit FKs), so the rls-guard treats them as operator surfaces, not
-- tenant data — the edge service-role client is the only read/write path.

-- ── Enums for the fixed value sets ─────────────────────────────────────────
create type public.ai_budget_period as enum ('day', 'month');
create type public.ai_budget_action as enum ('alert', 'throttle', 'kill');

-- ── (1) ai_budgets — operator-editable spend budgets ───────────────────────
create table if not exists public.ai_budgets (
  id          uuid primary key default gen_random_uuid(),
  -- The ai_usage_events.feature this budget caps (grading | autolister |
  -- content | reconcile | …). Free text (the feature set is extensible) — the
  -- spend rollup matches on it directly.
  feature     text not null,
  period      public.ai_budget_period not null,
  -- USD ceiling for the rolling period (day = since midnight, month = since the
  -- 1st). Measured against the SAME re-priced cost basis as the spend dashboard.
  limit_usd   numeric(12,2) not null check (limit_usd >= 0),
  -- alert  → record a breach + ops alert only.
  -- throttle → alert + mark breached (a future inline check can soft-throttle).
  -- kill   → alert + flip the matching feature_flag OFF (hard stop).
  action      public.ai_budget_action not null default 'alert',
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users(id) on delete set null
);

-- At most one budget per (feature, period) — the admin upserts on this pair.
create unique index if not exists ai_budgets_feature_period_key
  on public.ai_budgets (feature, period);

comment on table public.ai_budgets is
  'US-895: per-feature daily/monthly AI spend budgets. action alert|throttle|kill; '
  'kill flips the matching feature_flag off via the existing kill-switch. '
  'Operator-only (deny-all RLS, service-role writes). Evaluated by the scheduled '
  'ai-budget guardrails job against re-priced ai_usage_events.';

drop trigger if exists trg_ai_budgets_updated_at on public.ai_budgets;
create trigger trg_ai_budgets_updated_at
  before update on public.ai_budgets
  for each row execute function public.set_updated_at();

alter table public.ai_budgets enable row level security;
revoke all on public.ai_budgets from anon, authenticated;

-- ── (2) ai_budget_breaches — one row per recorded breach ───────────────────
create table if not exists public.ai_budget_breaches (
  id          uuid primary key default gen_random_uuid(),
  -- The budget that breached. SET NULL on delete so history survives a budget
  -- being removed; the denormalized feature/period/limit below keep it readable.
  budget_id   uuid references public.ai_budgets(id) on delete set null,
  feature     text not null,
  period      public.ai_budget_period not null,
  action      public.ai_budget_action not null,
  limit_usd   numeric(12,2) not null,
  spend_usd   numeric(12,4) not null,
  -- Whether the guardrail actually flipped a feature_flag off, and which one.
  killed      boolean not null default false,
  flag_key    text,
  -- Whether an ops alert was delivered to at least one channel.
  alerted     boolean not null default false,
  status      text not null default 'open' check (status in ('open', 'resolved')),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  -- Set when an operator re-enables / acknowledges the breach (the AI-spend page
  -- "re-enable" action — super_admin + step-up).
  resolved_at timestamptz,
  resolved_by uuid references public.users(id) on delete set null
);

-- At most one OPEN breach per budget: the job records a breach once and skips
-- while it stays open, so a per-minute cron doesn't pile up duplicates or
-- re-alert every tick. Resolving (re-enable) clears it; a later re-breach opens
-- a fresh row.
create unique index if not exists ai_budget_breaches_open_budget_key
  on public.ai_budget_breaches (budget_id)
  where status = 'open';

create index if not exists idx_ai_budget_breaches_status_created
  on public.ai_budget_breaches (status, created_at desc);

comment on table public.ai_budget_breaches is
  'US-895: audit trail of AI budget breaches recorded by the scheduled guardrails '
  'job — notes whether a feature_flag was auto-killed, with an open→resolved '
  'lifecycle the admin re-enable path drives. Operator-only (deny-all RLS).';

alter table public.ai_budget_breaches enable row level security;
revoke all on public.ai_budget_breaches from anon, authenticated;

-- ── (3) ai_budget_status() — current spend vs each budget ──────────────────
-- Re-prices ai_usage_events from the CURRENT system_settings.ai_model_prices
-- (same basis as ai_spend, 00218) and rolls it up per budget over that budget's
-- period window. Returns every budget with its spend + breached flag so the
-- scheduled evaluator and the admin page share one source of truth. Admin-gated
-- like ai_spend: the service-role edge client (auth.uid() null) passes; a
-- logged-in non-admin is rejected; anon is not granted.
create or replace function public.ai_budget_status()
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
$$;

comment on function public.ai_budget_status() is
  'US-895: every ai_budget with its current period spend (re-priced from '
  'system_settings.ai_model_prices) + breached flag. SECURITY DEFINER + '
  'is_admin() guard (reads cross-tenant ai_usage_events). Shared by the scheduled '
  'guardrails evaluator and the admin AI-spend page.';

grant execute on function public.ai_budget_status() to authenticated;
grant execute on function public.ai_budget_status() to service_role;
