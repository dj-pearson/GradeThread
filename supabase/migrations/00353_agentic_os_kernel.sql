-- 00353_agentic_os_kernel.sql
--
-- US-1583: the Agentic OS kernel substrate — agent registry, run ledger,
-- step transcript, proposal queue, and agent memory. Every later module
-- (runtime, policy engine, scheduler, Mission Control, the agents themselves)
-- builds on these five tables, so the shapes here are deliberately generic:
-- module-specific state rides the jsonb columns, never new tables per agent.
--
-- All five are OPERATOR-ONLY: RLS enabled with NO policies (service-role
-- access only; registered in rls-guard SERVICE_ROLE_ONLY). No tenant data
-- lives here — agents observe tenants through the audited tool registry, and
-- anything they retain lands in evidence/memory as aggregates.
--
-- Idempotent (US-1108 triple): guarded enum creates, IF NOT EXISTS
-- everywhere, DROP TRIGGER IF EXISTS before CREATE TRIGGER. Self-records.

-- ── Enums (guarded creates — ADD VALUE is not needed at v1) ─────────────────
DO $$ BEGIN
  CREATE TYPE public.agent_status AS ENUM ('enabled', 'paused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.agent_run_status AS ENUM
    ('queued', 'running', 'succeeded', 'failed', 'timeout', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.agent_step_type AS ENUM ('model_call', 'tool_call', 'output');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.agent_proposal_status AS ENUM
    ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── agents: the registry ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable machine key ("sentinel", "grading_quality", ...). Code references
  -- agents by key, never by uuid, so environments can re-seed freely.
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  -- The PRD module letter (A, B, C...) purely for operator orientation.
  module_letter text,
  status public.agent_status NOT NULL DEFAULT 'paused',
  -- Autonomy per ACTION CLASS (US-1586): {"notify":"L2","config_write":"L0",...}.
  -- The policy engine is the only reader; unknown classes default to L0.
  autonomy jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Everything an agent needs to run: schedule (cron expr / interval),
  -- tool allowlist, model id, prompt version, budget_usd_daily, module knobs.
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── agent_runs: the run ledger ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  -- What started it: "schedule" | "manual" | "handoff:<agent_key>" | "event:<topic>".
  trigger text NOT NULL,
  status public.agent_run_status NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd numeric(10, 4) NOT NULL DEFAULT 0,
  -- The run's structured result (each module defines its own shape).
  outcome jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_agent_started_idx
  ON public.agent_runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx
  ON public.agent_runs (status);

-- ── agent_run_steps: the step transcript ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  step_type public.agent_step_type NOT NULL,
  -- Tool name for tool_call, model id for model_call, output kind for output.
  name text NOT NULL,
  input jsonb,
  output jsonb,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS agent_run_steps_run_idx
  ON public.agent_run_steps (run_id, seq);

-- ── agent_proposals: the approval queue ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  -- The policy-engine action class this proposal wants to perform.
  action_class text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  -- What execution needs (tool + args), and why the operator should believe it.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.agent_proposal_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz,
  -- The deciding operator (auth user uuid) + audit trail.
  decided_by uuid,
  decided_at timestamptz,
  decide_reason text,
  -- Duplicate-suppression across runs: the same finding proposed twice maps
  -- to the same key and upserts instead of stacking the inbox.
  idempotency_key text UNIQUE,
  executed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_proposals_status_idx
  ON public.agent_proposals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_proposals_agent_idx
  ON public.agent_proposals (agent_id, created_at DESC);

-- ── agent_memory: durable learnings ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  -- "learning" | "fact" | "preference" | module-defined kinds.
  kind text NOT NULL,
  key text NOT NULL,
  content text NOT NULL,
  -- Assembly ranking weight; curation (US-1606) prunes low-weight rows.
  weight real NOT NULL DEFAULT 1.0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kind, key)
);

CREATE INDEX IF NOT EXISTS agent_memory_agent_idx
  ON public.agent_memory (agent_id, weight DESC);

-- ── updated_at triggers (shared set_updated_at() from 00001) ────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agents', 'agent_runs', 'agent_run_steps', 'agent_proposals', 'agent_memory'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ── Operator-only: RLS on, NO policies (service-role access only) ───────────
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory ENABLE ROW LEVEL SECURITY;

insert into public.applied_migrations (version) values ('00353') on conflict do nothing;
