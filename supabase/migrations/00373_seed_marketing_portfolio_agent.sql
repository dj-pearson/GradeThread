-- US-1599 / AGENTIC-OS Phase 1 (Module M): seed the Marketing Portfolio agent row.
--
-- One supervisor over the three self-tuning marketing engines (content,
-- newsletter, drip). Its value is EXCLUSIVELY the cross-engine view — audience
-- fatigue, blog/newsletter topic cannibalization, same-day channel collisions —
-- plus a weekly scorecard + next-week focus list. It proposes ENGINE-LEVEL levers
-- only: add a topic to a bank (add_marketing_topic), change the shared frequency
-- cap (adjust_frequency), or pause a fatiguing sequence (file_task). It NEVER
-- touches an individual send or subscriber. Prompt lives in the repo charter
-- (agents/charters/marketing-portfolio-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); scheduled WEEKLY on Monday 06:00 — before
-- the content digest so its focus list can steer the week. Idempotent
-- (ON CONFLICT (key) DO NOTHING). Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'marketing-portfolio',
  'Marketing Portfolio',
  'Weekly cross-engine supervisor over content, newsletter, and drip: per-channel scorecard + cross-channel fatigue/cannibalization/collision findings + a ranked next-week focus list. Proposes engine-level levers only (topic-bank additions, frequency-cap changes, sequence pauses); never touches a send or subscriber.',
  'M',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', '0 6 * * 1',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_marketing_portfolio'),
    'budget_usd_daily', 2,
    'proposal_ttl_hours', 120,
    'max_steps', 8,
    'token_floor', 600
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00373') ON CONFLICT DO NOTHING;
