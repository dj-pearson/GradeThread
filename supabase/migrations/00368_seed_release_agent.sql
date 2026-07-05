-- US-1610 / AGENTIC-OS Phase 2 (Module Q): seed the Release agent row.
--
-- Post-deploy verification: detects a RELEASE_SHA change and compares post-deploy
-- health (24h cron failures, webhook/email dead-letter depths) to the pre-deploy
-- baseline; a regression files an admin task with the commit range; a clean
-- deploy is an all-clear. It may propose run_smoke to actively re-verify. It
-- NEVER rolls back — rollback is a human procedure (ROLLBACK.md). Prompt lives in
-- the repo charter (agents/charters/release-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); scheduled hourly so it notices a deploy
-- soon after it lands. Idempotent (ON CONFLICT (key) DO NOTHING). Depends on
-- 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'release',
  'Release',
  'Post-deploy verification: detects a release-SHA change and compares post-deploy health to a pre-deploy baseline; files a regression admin task with the commit range or records an all-clear. Never rolls back.',
  'Q',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', '0 * * * *',
    'model', 'claude-haiku-4-5-20251001',
    'tools', jsonb_build_array('get_release_health'),
    'budget_usd_daily', 1,
    'proposal_ttl_hours', 72,
    'max_steps', 6,
    'token_floor', 500
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00368') ON CONFLICT DO NOTHING;
