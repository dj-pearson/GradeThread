-- US-831: usage metering + abuse storage for the AI Support Assistant
-- (EPIC: AI Support Assistant). This story is STORAGE + HELPERS only — the
-- threshold/enforcement logic lives in US-836; the engine gate (US-834) reads
-- users.support_assistant_locked_until before any model call.
--
-- Three things:
--   support_assistant_usage  — per-user/per-day rollup of message + token +
--                              escalation counts (cost/abuse accounting).
--   support_abuse_events     — append-only log of detected abuse, typed +
--                              severity-graded, optionally tied to a conversation.
--   users.support_assistant_locked_until — a temporary lockout timestamp set by
--                              the abuse pipeline and cleared by an admin or expiry.
--
-- SECURITY MODEL (mirrors support_assistant_schema 00181 + rate_limit_counters
-- 00045): RLS is ENABLED with NO policies on both tables → deny-all for the
-- anon/authenticated roles. Only the service-role edge client (which bypasses
-- RLS) and admins (via SECURITY DEFINER helpers, if added later) touch these
-- rows. Usage and abuse data are NEVER client-readable.
--
-- Enums modeled as text + CHECK (the dominant recent pattern) so the value set
-- can evolve without ALTER TYPE gymnastics. Idempotent via IF NOT EXISTS.

-- ── support_assistant_usage: per-day rollup ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_assistant_usage (
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  usage_date      date NOT NULL DEFAULT CURRENT_DATE,
  message_count   integer NOT NULL DEFAULT 0,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  escalation_count integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_date)
);

-- ── support_abuse_events: append-only abuse log ────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_abuse_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The chat that triggered the event; null for non-conversation signals
  -- (e.g. a flood detected before a conversation row exists).
  conversation_id uuid REFERENCES public.support_conversations(id) ON DELETE SET NULL,
  type            text NOT NULL
    CHECK (type IN (
      'jailbreak_attempt', 'prompt_injection', 'flood',
      'policy_violation', 'repeated_failure', 'scope_probe'
    )),
  severity        text NOT NULL
    CHECK (severity IN ('low', 'medium', 'high')),
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The abuse pipeline scans a user's recent events to decide thresholds (US-836).
CREATE INDEX IF NOT EXISTS idx_support_abuse_events_user
  ON public.support_abuse_events(user_id, created_at DESC);

-- ── users.support_assistant_locked_until ───────────────────────────────────
-- Temporary lockout set by the abuse pipeline; read by the engine gate (US-834)
-- before any model call. NULL = not locked. Cleared by admin or natural expiry.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS support_assistant_locked_until timestamptz;

-- updated_at on the usage rollup maintained by the standard trigger (00001).
DROP TRIGGER IF EXISTS set_support_assistant_usage_updated_at
  ON public.support_assistant_usage;
CREATE TRIGGER set_support_assistant_usage_updated_at
  BEFORE UPDATE ON public.support_assistant_usage
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: deny-all for clients; service-role bypasses ───────────────────────
ALTER TABLE public.support_assistant_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_abuse_events ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: usage + abuse rows are never client-readable.

-- ── Atomic daily-rollup upsert (mirrors increment_rate_limit, 00045) ───────
-- Adds the supplied deltas to today's row for the user, creating it on first
-- write of the day. Atomic via INSERT ... ON CONFLICT so concurrent edge
-- replicas can't lose an increment. Date defaults to the DB's CURRENT_DATE
-- (UTC) so the rollup boundary is consistent across replicas.
CREATE OR REPLACE FUNCTION public.increment_support_assistant_usage(
  p_user_id uuid,
  p_messages integer,
  p_input_tokens integer,
  p_output_tokens integer,
  p_escalations integer
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.support_assistant_usage AS u (
    user_id, usage_date, message_count,
    input_tokens, output_tokens, escalation_count
  )
  VALUES (
    p_user_id, CURRENT_DATE, COALESCE(p_messages, 0),
    COALESCE(p_input_tokens, 0), COALESCE(p_output_tokens, 0),
    COALESCE(p_escalations, 0)
  )
  ON CONFLICT (user_id, usage_date) DO UPDATE SET
    message_count    = u.message_count    + COALESCE(p_messages, 0),
    input_tokens     = u.input_tokens     + COALESCE(p_input_tokens, 0),
    output_tokens    = u.output_tokens    + COALESCE(p_output_tokens, 0),
    escalation_count = u.escalation_count + COALESCE(p_escalations, 0),
    updated_at       = now();
END;
$$;
