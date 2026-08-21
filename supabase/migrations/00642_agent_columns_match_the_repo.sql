-- US-2729 AC6: four agent columns are NOT NULL in production and nullable in
-- every migration. This settles it in the repo's favour, and does it as a
-- migration so applied_migrations records that it happened.
--
-- The audit found agent_proposals.evidence, agent_proposals.summary,
-- agent_run_steps.name and agent_runs.trigger stricter in prod than 00357
-- declares them, with no later migration adding the constraint — so prod's
-- copies of these tables did not come from the migration set.
--
-- WHY THE REPO WINS, and it is not a preference. The code writes NULL into
-- three of the four on purpose, so prod's constraint is a 23502 waiting to
-- fire in production only, where CI can never see it:
--
--   * agent-policy.ts dispatchWriteIntent builds every proposal with
--     `summary: intent.summary ?? null` and `evidence: intent.evidence ?? null`,
--     and coerceWriteIntent requires only action_class and title — so a model
--     that proposes without a summary produces exactly that row.
--   * agent-kernel.ts declares AgentStep.name as `string | null` and inserts it
--     straight into agent_run_steps.
--   * agent_runs.trigger is passed through from the caller.
--
-- Tightening the repo instead would mean pinning those four write paths
-- non-null first, which is a product change (what does a proposal with no
-- summary become?) rather than a schema correction. Relaxing is safe for every
-- existing row: dropping NOT NULL cannot invalidate data that satisfied it.
--
-- Idempotent by construction: DROP NOT NULL on an already-nullable column is a
-- no-op, so this is a no-op wherever the schema already came from 00357.

ALTER TABLE public.agent_proposals ALTER COLUMN evidence DROP NOT NULL;
ALTER TABLE public.agent_proposals ALTER COLUMN summary  DROP NOT NULL;
ALTER TABLE public.agent_run_steps ALTER COLUMN name     DROP NOT NULL;
ALTER TABLE public.agent_runs      ALTER COLUMN trigger  DROP NOT NULL;

insert into public.applied_migrations (version) values ('00642') on conflict do nothing;
