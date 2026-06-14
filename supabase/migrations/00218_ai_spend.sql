-- US-894: AI spend & token-usage dashboard.
--
-- Builds on the ai_usage_events ledger (migration 00163, written by
-- lib/ai-usage.ts). That ledger only recorded the GRADING pipeline's calls and
-- only carried phase/model/tokens/cost. This migration:
--   1. Extends the ledger so EVERY AI feature can log to it — adds `feature`
--      (grading | autolister | content | reconcile | …), `prompt_hash` (a fast
--      non-crypto fingerprint to spot a repeated/runaway prompt) and
--      `latency_ms`. Existing rows are all grading calls, so `feature` defaults
--      to 'grading' and backfills automatically.
--   2. Seeds a CONFIG-DRIVEN price table in system_settings (`ai_model_prices`)
--      so a price change is an operator edit, never a deploy (AC5).
--   3. Adds ai_spend(period, groupBy) — an admin-gated SECURITY DEFINER RPC that
--      re-prices the raw tokens from that config (so historical spend reflects
--      the current rate table) and rolls it up by model / feature / day, plus a
--      "top features today" list and today-vs-yesterday delta to make a spike
--      obvious (AC2/AC4).

-- ── 1. Extend the ai_usage_events ledger ───────────────────────────────────
alter table public.ai_usage_events
  add column if not exists feature     text not null default 'grading',
  add column if not exists prompt_hash text,
  add column if not exists latency_ms  integer check (latency_ms is null or latency_ms >= 0);

comment on column public.ai_usage_events.feature is
  'US-894: which AI feature made the call (grading | autolister | content | '
  'reconcile | catalog_extract | tag_ocr | photo_qa | photo_roles | …). '
  'Existing rows default to grading (the only feature that logged pre-894).';
comment on column public.ai_usage_events.prompt_hash is
  'US-894: fast non-crypto fingerprint of system+messages+model, to spot a '
  'repeated / runaway prompt. Not a security hash.';
comment on column public.ai_usage_events.latency_ms is
  'US-894: wall-clock latency of the Anthropic call in milliseconds.';

-- Spend rollups filter on created_at and group by feature/model.
create index if not exists idx_ai_usage_events_feature_created_at
  on public.ai_usage_events(feature, created_at desc);
create index if not exists idx_ai_usage_events_model_created_at
  on public.ai_usage_events(model, created_at desc);

-- ── 2. Config-driven per-model price table ─────────────────────────────────
-- USD per MILLION tokens. cache_write = 1.25× input, cache_read = 0.1× input
-- (Anthropic's standard 5-minute ephemeral cache multipliers). Mirrors the
-- defaults in lib/ai-usage.ts, but lives here so an operator can re-price
-- WITHOUT a deploy — the ai_spend RPC reads these rates at query time.
insert into public.system_settings (key, value, value_type, default_value, category, description)
values (
  'ai_model_prices',
  jsonb_build_object(
    'claude-opus-4-8',            jsonb_build_object('input', 5, 'output', 25, 'cache_write', 6.25, 'cache_read', 0.5),
    'claude-sonnet-4-6',          jsonb_build_object('input', 3, 'output', 15, 'cache_write', 3.75, 'cache_read', 0.3),
    'claude-haiku-4-5-20251001',  jsonb_build_object('input', 1, 'output', 5,  'cache_write', 1.25, 'cache_read', 0.1),
    'claude-haiku-4-5',           jsonb_build_object('input', 1, 'output', 5,  'cache_write', 1.25, 'cache_read', 0.1)
  ),
  'json',
  jsonb_build_object(
    'claude-opus-4-8',            jsonb_build_object('input', 5, 'output', 25, 'cache_write', 6.25, 'cache_read', 0.5),
    'claude-sonnet-4-6',          jsonb_build_object('input', 3, 'output', 15, 'cache_write', 3.75, 'cache_read', 0.3),
    'claude-haiku-4-5-20251001',  jsonb_build_object('input', 1, 'output', 5,  'cache_write', 1.25, 'cache_read', 0.1),
    'claude-haiku-4-5',           jsonb_build_object('input', 1, 'output', 5,  'cache_write', 1.25, 'cache_read', 0.1)
  ),
  'ai',
  'US-894: USD price per MILLION tokens per model (input/output/cache_write/cache_read). '
  'Read by the ai_spend RPC so AI cost is re-priceable without a deploy.'
) on conflict (key) do nothing;

-- ── 3. ai_spend(period, groupBy) RPC ───────────────────────────────────────
-- Guard pattern mirrors revenue_dashboard (00215): the service-role edge client
-- has a null auth.uid() and passes; a logged-in non-admin is rejected; anon is
-- not granted. Read-only — no audit / step-up.
create or replace function public.ai_spend(
  p_period   text default '30d',
  p_group_by text default 'feature'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period       text := lower(coalesce(p_period, '30d'));
  v_group        text := lower(coalesce(p_group_by, 'feature'));
  v_days         int;
  v_window_start timestamptz;
  v_series_start timestamptz;
  result         jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
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
$$;

comment on function public.ai_spend(text, text) is
  'US-894: admin-gated AI spend rollup. Re-prices ai_usage_events tokens from '
  'system_settings.ai_model_prices (config-driven, deploy-free) and aggregates '
  'by model/feature/day with a top-features-today + today-vs-yesterday delta. '
  'SECURITY DEFINER + is_admin() guard (reads cross-tenant data).';

grant execute on function public.ai_spend(text, text) to authenticated;
grant execute on function public.ai_spend(text, text) to service_role;
