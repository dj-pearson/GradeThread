-- US-1583 / AGENTIC-OS Phase 0 (Module A — Agent Kernel): the foundational
-- substrate for the governed agent fleet (AGENTIC_OS.md §2 guardrails, §3.A).
--
-- Five OPERATOR tables — no tenant data, no client access. The SPA never reads
-- them; all CRUD flows through the (future) role-gated /api/admin/agents +
-- /api/jobs/agent-tick edge paths on the service-role client. Per the
-- tenant-isolation skill they are RLS-enabled with ZERO policies (deny-all;
-- service role bypasses RLS) and registered in SERVICE_ROLE_ONLY in
-- rls-guard_test.ts. None carries a `user_id` column (agent_id / run_id /
-- decided_by are the keys), so none is auto-discovered as tenant-scoped.
--
-- Fixed-set columns use text + CHECK rather than Postgres ENUM types: the repo
-- convention for operator tables (measure_card_requests, admin_tasks, …) and it
-- sidesteps the enum caveats the migrations skill warns about (CREATE TYPE isn't
-- cleanly idempotent; a new ADD VALUE can't be used in the same transaction).
--
-- Schema only — no routes or kernel code in this story (US-1584 builds the run
-- loop on top). US-1108 triple: idempotent, EXPECTED_SCHEMA_VERSION bumped in
-- this commit, self-record footer.

-- ── agents: the registry ─────────────────────────────────────────────────────
-- One row per agent definition. `autonomy` is per-action-class:
-- { "<action_class>": 0|1|2|3 } (L0 observe is the default for any class not
-- listed). `config` holds schedule + tool allowlist + model + budget_usd_daily.
CREATE TABLE IF NOT EXISTS public.agents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL UNIQUE,
  name           text NOT NULL,
  description    text,
  module_letter  text CHECK (module_letter IS NULL OR char_length(module_letter) = 1),
  status         text NOT NULL DEFAULT 'paused'
                   CHECK (status IN ('enabled', 'paused')),
  autonomy       jsonb NOT NULL DEFAULT '{}'::jsonb,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── agent_runs: the run ledger ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  trigger      text,
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timeout', 'skipped')),
  started_at   timestamptz,
  finished_at  timestamptz,
  tokens_in    integer NOT NULL DEFAULT 0,
  tokens_out   integer NOT NULL DEFAULT 0,
  cost_usd     numeric(12, 4) NOT NULL DEFAULT 0,
  outcome      jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Run history for an agent, newest first (Mission Control run list + last-run health).
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started
  ON public.agent_runs (agent_id, started_at DESC);

-- ── agent_run_steps: the transcript ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_run_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  step_type    text NOT NULL
                 CHECK (step_type IN ('model_call', 'tool_call', 'output')),
  name         text,
  input        jsonb,
  output       jsonb,
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Steps in order for a run; UNIQUE so a crash-replay can't duplicate a step.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_steps_run_seq
  ON public.agent_run_steps (run_id, seq);

-- ── agent_proposals: the approval queue ──────────────────────────────────────
-- A structured write-action awaiting operator approval (autonomy L1). Approved
-- proposals are executed by the kernel with the proposal row as authorization;
-- `idempotency_key` (UNIQUE, NULLs allowed) makes execution replay-safe.
CREATE TABLE IF NOT EXISTS public.agent_proposals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  run_id           uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  action_class     text NOT NULL,
  title            text NOT NULL,
  summary          text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence         jsonb,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  expires_at       timestamptz,
  decided_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  decide_reason    text,
  idempotency_key  text UNIQUE,
  executed_at      timestamptz,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The proposals inbox is worked by status (pending first), newest surfaced first.
CREATE INDEX IF NOT EXISTS idx_agent_proposals_status
  ON public.agent_proposals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_proposals_agent
  ON public.agent_proposals (agent_id, created_at DESC);

-- ── agent_memory: durable per-agent notes ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_memory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  key           text NOT NULL,
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,
  weight        numeric NOT NULL DEFAULT 1,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One memory row per (agent, kind, key) so the kernel can upsert by that key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_agent_kind_key
  ON public.agent_memory (agent_id, kind, key);

-- ── RLS: operator-only, deny-all (service role bypasses) ─────────────────────
ALTER TABLE public.agents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_steps  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_proposals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory     ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: anon/authenticated get nothing; only the edge
-- service-role client (which bypasses RLS) reads/writes these.

-- ── updated_at triggers ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS set_agents_updated_at ON public.agents;
CREATE TRIGGER set_agents_updated_at
  BEFORE UPDATE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_agent_runs_updated_at ON public.agent_runs;
CREATE TRIGGER set_agent_runs_updated_at
  BEFORE UPDATE ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_agent_run_steps_updated_at ON public.agent_run_steps;
CREATE TRIGGER set_agent_run_steps_updated_at
  BEFORE UPDATE ON public.agent_run_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_agent_proposals_updated_at ON public.agent_proposals;
CREATE TRIGGER set_agent_proposals_updated_at
  BEFORE UPDATE ON public.agent_proposals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_agent_memory_updated_at ON public.agent_memory;
CREATE TRIGGER set_agent_memory_updated_at
  BEFORE UPDATE ON public.agent_memory
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00357') on conflict do nothing;
