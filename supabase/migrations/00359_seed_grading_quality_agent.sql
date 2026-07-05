-- US-1594 / AGENTIC-OS Phase 1 (Module G): seed the Grading Quality agent row.
--
-- Reads grading telemetry (accuracy, calibration, review queue, exemplar
-- coverage) into a weekly memo. It has NO grading write tools and can NEVER
-- execute a grading-config change — any prompt/threshold/calibration/exemplar
-- change it recommends is a file_task pointing at the human-driven shadow →
-- eval → canary lifecycle. Prompt lives in the repo charter
-- (agents/charters/grading-quality.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); the operator enables it in Mission
-- Control. Idempotent (ON CONFLICT (key) DO NOTHING). Depends on 00357 (agents).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'grading-quality',
  'Grading Quality',
  'Weekly grading accuracy synthesis: regressions/improvements per category + prompt version, calibration gaps, exemplar coverage holes. Recommends lifecycle changes as admin tasks; never mutates grading.',
  'G',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', 'weekly',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_grading_quality', 'get_review_queue_stats'),
    'budget_usd_daily', 2,
    'proposal_ttl_hours', 168,
    'max_steps', 6
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version.
INSERT INTO public.applied_migrations (version) VALUES ('00359') ON CONFLICT DO NOTHING;
