-- US-3527: a dollar cap on grading, and one price for Sonnet 5.
--
-- 1. isAiBudgetExhausted('grading') is checked on every grade submit
--    (grade.ts, api-v1.ts), but no migration ever created a 'grading' budget,
--    so the only backstop was AI_GLOBAL_DAILY_CALL_CEILING. Seed two rows:
--      day   $150  throttle: alerts, never stops grading
--      month $3000 kill:     a hard stop, because a month past this is a
--                            runaway (a retry or refund loop), not demand
--    At about $0.16 of AI per standard grade that is roughly 18,000 grades a
--    month. Both are operator-editable in admin. ON CONFLICT DO NOTHING: a row
--    an operator already created is left exactly as it is.
--
-- 2. 00335 seeded claude-sonnet-5 at $3/$15 as the "list" price. The $2/$10
--    rate became the standard price and the increase was cancelled; the edge
--    (ai-usage.ts MODEL_PRICES, checked 2026-09-11) already writes cost_usd at
--    $2/$10. The ai_spend / ai_profitability RPCs and the budget job re-price
--    from this setting, so AI Spend read 50% high and budgets would trip early.
--    Cache write = 1.25x input, cache read = 0.1x input, as ai-usage.ts.
--
-- Idempotent: the jsonb merge overwrites only the claude-sonnet-5 key.

INSERT INTO public.ai_budgets (feature, period, limit_usd, action, enabled)
VALUES
  ('grading', 'day',   150.00,  'throttle', true),
  ('grading', 'month', 3000.00, 'kill',     true)
ON CONFLICT (feature, period) DO NOTHING;

UPDATE public.system_settings
SET
  value = value || jsonb_build_object(
    'claude-sonnet-5',
    jsonb_build_object('input', 2, 'output', 10, 'cache_write', 2.5, 'cache_read', 0.2)
  ),
  default_value = default_value || jsonb_build_object(
    'claude-sonnet-5',
    jsonb_build_object('input', 2, 'output', 10, 'cache_write', 2.5, 'cache_read', 0.2)
  )
WHERE key = 'ai_model_prices';

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00841') ON CONFLICT DO NOTHING;
