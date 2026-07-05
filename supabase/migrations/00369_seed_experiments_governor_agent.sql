-- US-1609 / AGENTIC-OS Phase 2 (Module X): seed the Experiments Governor row.
--
-- One registry over every LIVE A/B in the platform (newsletter subject tests,
-- grading-prompt canaries, drip variants). The engines keep running their own
-- A/B math; this agent governs the PORTFOLIO: interference (two live tests on
-- the same audience + metric with overlapping windows), underpowered reads
-- presented as "wins", and experiments left running past their decision date.
-- It NEVER stops, extends, promotes, or reconfigures an experiment — those are
-- engine-owned, grade-/revenue-sensitive actions; it files an admin task
-- (file_task) for an operator. Prompt lives in the repo charter
-- (agents/charters/experiments-governor-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); scheduled twice weekly (Mon/Thu 07:00)
-- so it reviews the portfolio on a cadence without adding tick noise.
-- Idempotent (ON CONFLICT (key) DO NOTHING). Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'experiments-governor',
  'Experiments Governor',
  'Portfolio governance over every live A/B (newsletter, grading-prompt canaries, drip): flags interference, underpowered "wins", and experiments past their decision date; files an admin task with a concrete remedy. Never stops or promotes an experiment itself.',
  'X',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', '0 7 * * 1,4',
    'model', 'claude-haiku-4-5-20251001',
    'tools', jsonb_build_array('get_experiments_registry'),
    'budget_usd_daily', 1,
    'proposal_ttl_hours', 96,
    'max_steps', 6,
    'token_floor', 500
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00369') ON CONFLICT DO NOTHING;
