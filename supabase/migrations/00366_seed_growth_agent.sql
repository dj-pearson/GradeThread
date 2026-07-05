-- US-1602 / AGENTIC-OS Phase 1 (Module R): seed the Growth agent row.
--
-- Weekly funnel/retention anomaly narration + referral-program health, feeding a
-- ranked experiment slate the agent REVISITS week over week (reads its own prior
-- run outcome for continuity). It GENERATES and RANKS experiment ideas and files
-- the top briefs as admin tasks; it does NOT start experiments (Module X /
-- US-1609 governs execution). Prompt lives in the repo charter
-- (agents/charters/growth-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); scheduled weekly. Idempotent
-- (ON CONFLICT (key) DO NOTHING). Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'growth',
  'Growth',
  'Weekly funnel anomaly narration + referral health + a ranked, run-over-run experiment slate. Files experiment briefs as admin tasks; generates and ranks ideas but never starts experiments.',
  'R',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', 'weekly',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_growth_health'),
    'budget_usd_daily', 2,
    'proposal_ttl_hours', 168,
    'max_steps', 8,
    'token_floor', 800
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00366') ON CONFLICT DO NOTHING;
