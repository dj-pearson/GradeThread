-- US-1593 / AGENTIC-OS Phase 1 (Module H): seed the Sentinel agent row.
--
-- The FIRST domain agent — the reference seeding pattern US-1594..1604 copy:
-- an `agents` row whose config carries the schedule, model, read-tool allowlist,
-- and budget; the PROMPT lives in the repo charter (agents/charters/sentinel.ts),
-- not here. Seeded PAUSED at L0 (autonomy '{}') — the operator reviews it in
-- Mission Control and enables it (and grants L1 per action-class) when ready.
--
-- Idempotent: ON CONFLICT (key) DO NOTHING, so re-running never disturbs an
-- operator's later edits to the row (status/autonomy/config). No data beyond the
-- seed. Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'sentinel',
  'Sentinel',
  'Health & incident triage: correlates cron failures, dead letters, and warning ops events into incidents, files runbook-cited admin tasks, and proposes safe remediations.',
  'H',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', '30m',
    'model', 'claude-haiku-4-5-20251001',
    'tools', jsonb_build_array(
      'get_incidents', 'get_cron_health', 'get_ops_events', 'get_dead_letters', 'get_system_health'
    ),
    'budget_usd_daily', 1,
    'proposal_ttl_hours', 72,
    'max_steps', 8,
    'token_floor', 400
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00358') ON CONFLICT DO NOTHING;
