-- US-1611 / AGENTIC-OS Phase 2 (Module J): seed the Cron-fleet governance agent.
--
-- IMPLEMENTER'S CHOICE (documented, per the AC): a SMALL DEDICATED agent rather
-- than folding into the Sentinel charter — Sentinel triages incidents at 30m
-- cadence; fleet governance is a WEEKLY schedule-vs-reality diff, a distinct
-- concern with its own tool + report, so it gets its own row.
--
-- It reports the runtime diff between CRON_REGISTRY (the schedule) and cron_runs
-- (reality): missed ticks (maintenance-window-suppressed), duration creep, and a
-- stalled/slow scorecard. Proposes schedule-adjustment admin tasks only — Coolify
-- config is human-applied; it NEVER changes a schedule. Prompt lives in the repo
-- charter (agents/charters/cron-governance-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); weekly. Idempotent (ON CONFLICT (key) DO
-- NOTHING). Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'cron-governance',
  'Cron Governance',
  'Weekly runtime health of the scheduled-job fleet: missed-tick detection (registry vs cron_runs, maintenance-suppressed), duration creep, stalled/slow scorecard. Files schedule-adjustment admin tasks; never changes Coolify config.',
  'J',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', 'weekly',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_cron_fleet_health', 'get_cron_health'),
    'budget_usd_daily', 1,
    'proposal_ttl_hours', 168,
    'max_steps', 6,
    'token_floor', 600
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00367') ON CONFLICT DO NOTHING;
