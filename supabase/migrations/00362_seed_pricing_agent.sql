-- US-1601 / AGENTIC-OS Phase 1 (Module P): seed the Pricing agent row.
--
-- Operator-side oversight of the repricing / automation engines: repricing
-- efficacy, ping-ponging listings, churning automation rules, and price-curve
-- staleness — CROSS-TENANT AGGREGATES ONLY. It audits and reports; it NEVER
-- edits a tenant's rules or prices (tenant automations are user-owned). It may
-- propose a retry_job on the curve-refresh cron and file admin tasks. Prompt
-- lives in the repo charter (agents/charters/pricing-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); the operator enables it in Mission
-- Control and grants L1 per action-class when ready. Runs every 2 days.
-- Idempotent (ON CONFLICT (key) DO NOTHING). Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'pricing',
  'Pricing',
  'Cross-tenant repricing efficacy, ping-pong / rule-churn detection, and price-curve staleness. Proposes curve-refresh retries and files admin tasks for pathological tenant rules; never edits rules or prices.',
  'P',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', 'daily',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_pricing_health'),
    'budget_usd_daily', 2,
    'proposal_ttl_hours', 72,
    'max_steps', 8,
    'token_floor', 600
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00362') ON CONFLICT DO NOTHING;
