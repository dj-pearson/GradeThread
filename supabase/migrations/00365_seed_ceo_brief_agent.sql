-- US-1603 / AGENTIC-OS Phase 1 (Module Y): seed the CEO Brief chief-analyst.
--
-- The weekly north-star digest as a narrated decision memo: headline metrics vs
-- last week, a cause narrative that cites which agent observed what, fleet
-- actions taken/pending, "the one decision this week", and risks. Reads north-
-- star metrics + the fleet's latest run outcomes (get_ceo_brief) and narrates.
-- HONESTY: attributes a cause only to an agent that actually ran; degrades to
-- metrics + an "unattributed" note otherwise. Purely observational — it proposes
-- nothing to execute. Prompt lives in the repo charter
-- (agents/charters/ceo-brief-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); scheduled weekly, AFTER the other weekly
-- agents so it can cite their runs. Idempotent (ON CONFLICT (key) DO NOTHING).
-- Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'ceo-brief',
  'CEO Brief',
  'Weekly chief-analyst: narrates north-star metrics vs last week into a decision memo, citing which agent observed each cause (honest attribution / graceful degradation). Observational only — proposes nothing to execute.',
  'Y',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', 'weekly',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_ceo_brief'),
    'budget_usd_daily', 2,
    'proposal_ttl_hours', 168,
    'max_steps', 6,
    'token_floor', 800
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00365') ON CONFLICT DO NOTHING;
