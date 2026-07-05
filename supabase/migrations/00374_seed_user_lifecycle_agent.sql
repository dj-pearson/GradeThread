-- US-1600 / AGENTIC-OS Phase 1 (Module U): seed the User Lifecycle agent row.
--
-- Judgment on TOP of the drip engine, not a second sender. It reads COHORT-LEVEL
-- lifecycle data (activation funnel, drip enroll/convert/churn by week, trial-
-- expiry buckets), diagnoses where users stall, narrates churn risk, and sizes
-- winback. It proposes cohort-level moves only: enroll a defined cohort in an
-- existing drip campaign (enroll_cohort — the drip engine + frequency caps still
-- own every send), or a new-drip-variant admin task (file_task). It NEVER emails
-- anyone or touches an individual user. Prompt lives in the repo charter
-- (agents/charters/user-lifecycle-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); scheduled WEEKLY on Monday 05:00 — before
-- the marketing portfolio review so its churn/winback read can inform it.
-- Idempotent (ON CONFLICT (key) DO NOTHING). Depends on 00357 (the agents table).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'user-lifecycle',
  'User Lifecycle',
  'Weekly cohort-level lifecycle analyst: activation-stall diagnosis, churn-risk narrative vs prior weeks, and winback sizing. Proposes cohort enrollment into existing drip campaigns + new-variant admin tasks; never emails anyone (the drip engine + frequency caps own delivery).',
  'U',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', '0 5 * * 1',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_user_lifecycle'),
    'budget_usd_daily', 2,
    'proposal_ttl_hours', 120,
    'max_steps', 8,
    'token_floor', 600
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00374') ON CONFLICT DO NOTHING;
