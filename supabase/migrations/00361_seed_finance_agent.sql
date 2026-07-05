-- US-1596 / AGENTIC-OS Phase 1 (Module F): seed the Finance agent row.
--
-- Daily books-watcher: ranks open billing-reconciliation divergences, checks
-- affiliate/consignor payout-run sanity, compares revenue to its trailing
-- window, and reads AI spend vs revenue (ai_profitability RPC). READ-HEAVY —
-- it narrates and files admin tasks; it NEVER moves money or credits and takes
-- no direct account action. Prompt lives in the repo charter
-- (agents/charters/finance-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); the operator enables it in Mission
-- Control and grants L1 on file_task when ready. Scheduled daily so it runs
-- after the billing-reconciliation cron has refreshed the flags. Idempotent
-- (ON CONFLICT (key) DO NOTHING). Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'finance',
  'Finance',
  'Daily reconciliation-delta, payout-sanity, revenue-baseline, and AI-spend-vs-revenue read. Files admin tasks for divergences and failed payout runs; never moves money or credits.',
  'F',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', 'daily',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_finance_health', 'get_revenue_window', 'get_ai_spend'),
    'budget_usd_daily', 2,
    'proposal_ttl_hours', 72,
    'max_steps', 8,
    'token_floor', 600
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00361') ON CONFLICT DO NOTHING;
