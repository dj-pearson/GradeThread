-- US-1598 / AGENTIC-OS Phase 1 (Module L): seed the Marketplace Ops agent row.
--
-- FlipDesk operational health across tenants (operator view): per-marketplace
-- connection verdicts, generation + publish batch backlog (stuck/failed), open
-- sync-conflicts, orphan sales, and the backlog trend. OPERATOR-SCOPE AGGREGATES
-- ONLY. It reports and proposes UNSTICK paths through existing reclaim/sweep
-- jobs (retry_job) + files admin tasks for connection problems; it NEVER mutates
-- a tenant's listings or inventory. Prompt lives in the repo charter
-- (agents/charters/marketplace-ops-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); the operator enables it in Mission
-- Control and grants L1 per action-class when ready. Runs twice daily.
-- Idempotent (ON CONFLICT (key) DO NOTHING). Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'marketplace-ops',
  'Marketplace Ops',
  'Cross-tenant FlipDesk pipeline health: marketplace verdicts, stuck/failed batch backlog, sync conflicts, orphan sales, backlog trend. Proposes reclaim-cron retries + connection admin tasks; never mutates tenant listings/inventory.',
  'L',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', 'daily',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_marketplace_ops_health', 'get_marketplace_health'),
    'budget_usd_daily', 2,
    'proposal_ttl_hours', 72,
    'max_steps', 8,
    'token_floor', 600
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00363') ON CONFLICT DO NOTHING;
