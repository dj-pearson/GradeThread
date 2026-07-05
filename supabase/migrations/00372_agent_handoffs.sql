-- US-1613 / AGENTIC-OS Phase 2 (Modules E+N): agent-to-agent handoffs.
--
-- A handoff moves INFORMATION between agents, never AUTHORITY: one agent's
-- finding becomes another agent's queued input, delivered via context assembly on
-- the target's next run, with a provenance chain (origin agent + run id) carried
-- through. Acceptance (accepts_handoffs_from) + a hop cap are enforced in the
-- kernel (agent-handoffs.ts); an unaccepted / hop-capped handoff downgrades to an
-- admin task instead of being delivered. See AGENTIC_OS.md §3.E.
--
-- OPERATOR TABLE: deny-all RLS, service-role writes only — no tenant data (agent
-- keys + run ids + the finding payload the emitting agent produced). Registered in
-- rls-guard_test.ts SERVICE_ROLE_ONLY. Owner column is named owner_user_id-free
-- on purpose (there is none; this is fleet infrastructure). Idempotent.

CREATE TABLE IF NOT EXISTS public.agent_handoffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The agent KEY (not id) this handoff is queued for; matched on the target's run.
  target_agent   text NOT NULL,
  origin_agent   text NOT NULL,
  origin_run_id  uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  kind           text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Hop counter (= provenance length); the kernel caps chains at HANDOFF_HOP_CAP.
  hop            integer NOT NULL DEFAULT 1,
  -- The full origin chain [{agent, run_id}, …] for auditability.
  provenance     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status         text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'consumed')),
  -- Which of the target's runs consumed this handoff (null until consumed).
  consumed_run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The target's next-run pull: queued handoffs for this agent, oldest first.
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_target_queued
  ON public.agent_handoffs (target_agent, created_at)
  WHERE status = 'queued';

ALTER TABLE public.agent_handoffs ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: anon/authenticated get nothing; only the service-role
-- edge client (which bypasses RLS) reads/writes. Mirrors agent_memory (00357).

DROP TRIGGER IF EXISTS set_agent_handoffs_updated_at ON public.agent_handoffs;
CREATE TRIGGER set_agent_handoffs_updated_at
  BEFORE UPDATE ON public.agent_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Wire the acceptance policy for the two shipping examples (AC4) ────────────
-- Sentinel accepts Support's ticket-cluster handoffs; the Integrations Watchdog
-- accepts Sentinel's vendor-degradation handoffs. Merged into existing config
-- (jsonb || ), idempotent, and a no-op if the agent row isn't seeded yet.
UPDATE public.agents
  SET config = config || jsonb_build_object('accepts_handoffs_from', jsonb_build_array('support-triage'))
  WHERE key = 'sentinel'
    AND NOT (config ? 'accepts_handoffs_from');

UPDATE public.agents
  SET config = config || jsonb_build_object('accepts_handoffs_from', jsonb_build_array('sentinel'))
  WHERE key = 'integrations-watchdog'
    AND NOT (config ? 'accepts_handoffs_from');

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00372') ON CONFLICT DO NOTHING;
