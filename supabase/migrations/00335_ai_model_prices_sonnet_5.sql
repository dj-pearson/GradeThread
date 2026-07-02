-- 00335: Track Claude Sonnet 5 in the config-driven AI price table.
--
-- The edge service's DEFAULT_AI_MODEL is now `claude-sonnet-5` (grading, the
-- composite pass, and every photo-bearing AI action route through it). The
-- price table seeded in 00218 only carried opus-4-8 / sonnet-4-6 / haiku rows,
-- so the `ai_spend` and `ai_profitability` RPCs were re-pricing every Sonnet 5
-- token at $0 (unknown model → 0) — the AI Spend + AI Profitability dashboards
-- have been silently under-reporting cost/margin since the model switch.
--
-- Rates: LIST price, USD per MILLION tokens — input 3 / output 15 (same sticker
-- as Sonnet 4.6), cache_write = 1.25× input, cache_read = 0.1× input. Anthropic's
-- introductory Sonnet 5 rate ($2/$10 through 2026-08-31) is a promo, not the
-- durable list price, so the compiled default stays at list; apply the intro rate
-- deploy-free by editing this system_setting in admin and revert after the promo.
--
-- Kept in lockstep with MODEL_PRICES in services/edge-functions/src/lib/ai-usage.ts
-- (which computes the stored ai_usage_events.cost_usd column at write time).
--
-- Idempotent: the jsonb `||` merge overwrites the `claude-sonnet-5` key on each
-- run and leaves every other model untouched.

update public.system_settings
set
  value = value || jsonb_build_object(
    'claude-sonnet-5',
    jsonb_build_object('input', 3, 'output', 15, 'cache_write', 3.75, 'cache_read', 0.3)
  ),
  default_value = default_value || jsonb_build_object(
    'claude-sonnet-5',
    jsonb_build_object('input', 3, 'output', 15, 'cache_write', 3.75, 'cache_read', 0.3)
  )
where key = 'ai_model_prices';

-- US-1108 self-record footer: keep the edge boot guard in sync no matter how the
-- migration is applied.
insert into public.applied_migrations (version) values ('00335') on conflict do nothing;
