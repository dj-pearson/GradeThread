-- US-1604 / AGENTIC-OS Phase 1 (Module I): seed the Integrations Watchdog agent.
--
-- Vendor-facing SRE: OAuth token-fleet expiry, external-vendor health (from ops
-- events), and the key-rotation calendar (KEY_ROTATION.md encoded as data). It
-- reads ABOUT credentials — expiry metadata + cadences, never secret material —
-- and files admin tasks; it touches no credential and rotates nothing. Prompt
-- lives in the repo charter (agents/charters/integrations-watchdog.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); the operator enables it in Mission
-- Control and grants L1 on file_task when ready. Idempotent
-- (ON CONFLICT (key) DO NOTHING). Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'integrations-watchdog',
  'Integrations Watchdog',
  'Vendor health, OAuth token-fleet expiry forecasting, and the key-rotation calendar. Narrates degradations and files admin tasks for overdue rotations / vendor degradation; never touches credentials.',
  'I',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', 'daily',
    'model', 'claude-haiku-4-5-20251001',
    'tools', jsonb_build_array('get_integrations_health', 'get_marketplace_health'),
    'budget_usd_daily', 1,
    'proposal_ttl_hours', 72,
    'max_steps', 6,
    'token_floor', 500
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00360') ON CONFLICT DO NOTHING;
