-- US-1065: Full AI model evaluation & per-feature profitability report.
--
-- The AI-spend surface (00218) answers "what did we spend, by model/feature/day".
-- This story answers the harder, operator-facing question: "is each AI use case
-- PROFITABLE, and which model tier should it run on?" It adds the formal,
-- repeatable evaluation deliverable:
--
--   1. Two config-driven seeds in system_settings so the economics + modeled
--      scenarios are operator-tunable WITHOUT a deploy (mirrors ai_model_prices):
--        • ai_feature_economics — per-feature {label, current/recommended model,
--          quality note, how revenue attaches, revenue-per-action, the
--          subscription fee the feature is bundled into (for break-even), and a
--          fallback per-action cost used to project features that have no ledger
--          data yet}.
--        • ai_usage_scenarios — modeled monthly usage profiles (internal QA, a
--          typical solo eBay seller, a power seller, a blended platform view)
--          with per-feature monthly action volumes + modeled monthly revenue.
--
--   2. ai_profitability(period) — an admin-gated SECURITY DEFINER RPC that
--      re-prices the REAL ai_usage_events ledger (same basis as ai_spend), rolls
--      it up per feature into cost-per-action / cost-per-call / gross margin, and
--      projects monthly AI spend vs revenue under each modeled scenario (using
--      OBSERVED per-action cost where the ledger has data, falling back to the
--      modeled cost otherwise). It flags any per-action feature whose AI cost is
--      creeping toward its revenue.
--
-- Guard pattern matches ai_spend/ai_budget_status: the service-role edge client
-- (auth.uid() null) passes; a logged-in non-admin is rejected; anon not granted.

-- ── 1. Per-feature economics (config-driven, deploy-free) ───────────────────
-- revenue_basis:
--   'per_action'   — direct revenue per action (grading, authenticity add-on).
--   'subscription' — bundled into a FlipDesk plan fee; margin is measured by how
--                    many actions/month it takes to consume that fee (break-even).
--   'none'         — indirect (platform marketing / support deflection); no
--                    per-action revenue, watched on absolute spend only.
-- action_unit: 'submission' (per graded item, cost = sum over submission_id) or
--   'call' (per Anthropic call). fallback_cost_per_action_usd seeds scenario
--   projections for features the ledger hasn't recorded yet.
insert into public.system_settings (key, value, value_type, default_value, category, description)
values (
  'ai_feature_economics',
  jsonb_build_object(
    'grading', jsonb_build_object(
      'label', 'Grading',
      'action_unit', 'submission',
      'revenue_basis', 'per_action',
      'revenue_per_action_usd', 2.99,
      'subscription_ref_usd', 0,
      'current_model', 'claude-sonnet-4-6',
      'recommended_model', 'claude-sonnet-4-6',
      'quality_note', 'Vision grading across 5 factors — sonnet is the quality floor; haiku alone underscores cosmetic/structural defects. The confidence-gated cascade (US-1066) already lets haiku handle the confident majority and escalates only low-confidence/high-value items, so per-grade cost trends toward haiku without a quality hit.',
      'fallback_cost_per_action_usd', 0.02
    ),
    'authenticity', jsonb_build_object(
      'label', 'Authenticity check',
      'action_unit', 'submission',
      'revenue_basis', 'per_action',
      'revenue_per_action_usd', 1.99,
      'subscription_ref_usd', 0,
      'current_model', 'claude-sonnet-4-6',
      'recommended_model', 'claude-sonnet-4-6',
      'quality_note', 'Brand/authenticity inspection is vision-heavy and liability-sensitive — keep on sonnet. A wrong "authentic" is a guarantee claim, far costlier than the token delta.',
      'fallback_cost_per_action_usd', 0.03
    ),
    'autolister', jsonb_build_object(
      'label', 'AutoLister / Listings',
      'action_unit', 'call',
      'revenue_basis', 'subscription',
      'revenue_per_action_usd', 0,
      'subscription_ref_usd', 29,
      'current_model', 'claude-sonnet-4-6',
      'recommended_model', 'claude-haiku-4-5-20251001',
      'quality_note', 'Title/spec/category drafting is structured extraction — haiku is adequate and ~3x cheaper. Reserve sonnet for ambiguous or high-value items via a value gate; the seller edits drafts anyway.',
      'fallback_cost_per_action_usd', 0.01
    ),
    'content', jsonb_build_object(
      'label', 'Content (marketing/SEO)',
      'action_unit', 'call',
      'revenue_basis', 'none',
      'revenue_per_action_usd', 0,
      'subscription_ref_usd', 0,
      'current_model', 'claude-sonnet-4-6',
      'recommended_model', 'claude-haiku-4-5-20251001',
      'quality_note', 'Blog/SEO drafts are always human-reviewed before publish — a haiku draft + human edit is the cost-optimal loop. Indirect revenue (organic acquisition); watch on absolute monthly spend, not per-action margin.',
      'fallback_cost_per_action_usd', 0.03
    ),
    'reconcile', jsonb_build_object(
      'label', 'Payout reconciliation',
      'action_unit', 'call',
      'revenue_basis', 'subscription',
      'revenue_per_action_usd', 0,
      'subscription_ref_usd', 29,
      'current_model', 'claude-haiku-4-5-20251001',
      'recommended_model', 'claude-haiku-4-5-20251001',
      'quality_note', 'Deterministic matching of payouts to sales — haiku is sufficient; most of this should be rules, with AI only on the fuzzy remainder.',
      'fallback_cost_per_action_usd', 0.005
    ),
    'catalog_extract', jsonb_build_object(
      'label', 'Catalog extract (tag OCR)',
      'action_unit', 'call',
      'revenue_basis', 'subscription',
      'revenue_per_action_usd', 0,
      'subscription_ref_usd', 29,
      'current_model', 'claude-haiku-4-5-20251001',
      'recommended_model', 'claude-haiku-4-5-20251001',
      'quality_note', 'Brand/size/material OCR from tag photos — a textbook haiku task; sonnet adds cost without measurable accuracy gain.',
      'fallback_cost_per_action_usd', 0.006
    ),
    'photo_qa', jsonb_build_object(
      'label', 'Photo QA / roles',
      'action_unit', 'call',
      'revenue_basis', 'subscription',
      'revenue_per_action_usd', 0,
      'subscription_ref_usd', 29,
      'current_model', 'claude-haiku-4-5-20251001',
      'recommended_model', 'claude-haiku-4-5-20251001',
      'quality_note', 'Is-this-the-back / is-it-blurry classification — haiku, batched. High call volume makes model choice matter most here.',
      'fallback_cost_per_action_usd', 0.003
    ),
    'support_assistant', jsonb_build_object(
      'label', 'Support assistant',
      'action_unit', 'call',
      'revenue_basis', 'none',
      'revenue_per_action_usd', 0,
      'subscription_ref_usd', 0,
      'current_model', 'claude-haiku-4-5-20251001',
      'recommended_model', 'claude-haiku-4-5-20251001',
      'quality_note', 'KB-grounded deflection — haiku. Escalate hard tickets to a human, never to opus; the cost of a confidently-wrong support answer exceeds the token saving.',
      'fallback_cost_per_action_usd', 0.004
    )
  ),
  'json',
  '{}'::jsonb,
  'ai',
  'US-1065: per-feature AI economics (model choice, revenue attribution, '
  'quality notes, fallback per-action cost). Read by ai_profitability() to '
  'compute gross margin + project scenarios. Operator-tunable, no deploy.'
) on conflict (key) do nothing;

-- ── 2. Modeled monthly usage scenarios ─────────────────────────────────────
-- volumes = monthly action count per feature; monthly_revenue_usd = the revenue
-- that usage produces (subscription fee + per-action revenue). The RPC multiplies
-- volumes by OBSERVED per-action cost (ledger) where available, else the
-- feature's fallback_cost_per_action_usd, to project monthly AI spend vs revenue.
insert into public.system_settings (key, value, value_type, default_value, category, description)
values (
  'ai_usage_scenarios',
  jsonb_build_array(
    jsonb_build_object(
      'key', 'internal_qa',
      'label', 'Internal QA / smoke',
      'description', 'Baseline internal usage — eval runs, QA grades, content drafts. Cost center: no attributed revenue.',
      'monthly_revenue_usd', 0,
      'volumes', jsonb_build_object('grading', 200, 'autolister', 100, 'content', 60, 'photo_qa', 300, 'support_assistant', 100)
    ),
    jsonb_build_object(
      'key', 'solo_seller',
      'label', 'Solo eBay seller (Pro $29/mo)',
      'description', 'Typical single-operator reseller: ~40 items/mo through the full pipeline on the Pro plan.',
      'monthly_revenue_usd', 29,
      'volumes', jsonb_build_object('grading', 40, 'autolister', 60, 'catalog_extract', 40, 'photo_qa', 120, 'reconcile', 30, 'support_assistant', 8)
    ),
    jsonb_build_object(
      'key', 'power_seller',
      'label', 'Power seller (Business $99/mo)',
      'description', 'High-volume reseller: ~200 items/mo on the Business plan with heavy autolist + photo QA.',
      'monthly_revenue_usd', 99,
      'volumes', jsonb_build_object('grading', 200, 'autolister', 400, 'catalog_extract', 200, 'photo_qa', 600, 'reconcile', 200, 'support_assistant', 20)
    ),
    jsonb_build_object(
      'key', 'platform_blended',
      'label', 'Platform blended (1k sellers)',
      'description', 'Blended platform projection at 1,000 active sellers (mix of pay-per-grade + subscription), modeled monthly revenue.',
      'monthly_revenue_usd', 42000,
      'volumes', jsonb_build_object('grading', 30000, 'authenticity', 4000, 'autolister', 80000, 'catalog_extract', 40000, 'content', 400, 'photo_qa', 160000, 'reconcile', 20000, 'support_assistant', 6000)
    )
  ),
  'json',
  '[]'::jsonb,
  'ai',
  'US-1065: modeled monthly AI usage scenarios (per-feature action volumes + '
  'modeled revenue). Read by ai_profitability() to project spend vs revenue. '
  'Operator-tunable, no deploy.'
) on conflict (key) do nothing;

-- ── 3. ai_profitability(period) RPC ────────────────────────────────────────
create or replace function public.ai_profitability(
  p_period text default '30d'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period       text := lower(coalesce(p_period, '30d'));
  v_days         int;
  v_window_start timestamptz;
  v_econ         jsonb;
  v_scenarios    jsonb;
  result         jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
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
$$;

comment on function public.ai_profitability(text) is
  'US-1065: admin-gated per-feature AI profitability. Re-prices ai_usage_events '
  '(system_settings.ai_model_prices) into cost-per-action / gross margin per '
  'feature and projects monthly spend vs revenue under modeled ai_usage_scenarios '
  '(observed CPA where the ledger has data, else the configured fallback). '
  'SECURITY DEFINER + is_admin() guard (reads cross-tenant data).';

grant execute on function public.ai_profitability(text) to authenticated;
grant execute on function public.ai_profitability(text) to service_role;
