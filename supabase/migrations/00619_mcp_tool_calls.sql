-- US-9113: audit log for MCP connector tool calls.
--
-- A durable record of what the Claude connector did on a seller's behalf, so
-- "I did not do that" is answered from data rather than from memory. Written
-- fire-and-forget by the tool dispatcher; read by operators through the
-- service-role client.
--
-- Deny-all by design. The rows name which seller acted and what they acted on,
-- so a readable audit log is a map of every seller's activity; a writable one
-- lets a caller fabricate the record that would exonerate them. Registered in
-- SERVICE_ROLE_ONLY in rls-guard_test.ts.
--
-- RETENTION: 400 days. Long enough to cover a full year of disputes plus the
-- chargeback tail, short enough that the table does not become the largest
-- thing in the database. Enforced by the sweep at the bottom of this file.
--
-- The owner column is `owner_user_id`, per the rls-guard discovery convention
-- for deny-all tables.

CREATE TABLE IF NOT EXISTS public.mcp_tool_calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  api_key_id         uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  session_id         text,
  tool_name          text NOT NULL,
  -- Redacted before storage: a shape summary plus the ids that were acted on.
  -- Never image bytes, never a full description, never a credential.
  arguments_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_status      text NOT NULL,
  error_code         text,
  duration_ms        integer,
  cost_cents         integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- "What did this seller do, most recent first" is the investigation query.
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_owner_created
  ON public.mcp_tool_calls (owner_user_id, created_at DESC);

-- "How is this tool behaving across the fleet" is the operations query.
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_tool_created
  ON public.mcp_tool_calls (tool_name, created_at DESC);

-- Supports the retention sweep without scanning the table.
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_created
  ON public.mcp_tool_calls (created_at);

ALTER TABLE public.mcp_tool_calls ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all for anon and authenticated. A seller sees their own
-- connector activity through an authenticated endpoint that filters for them,
-- never by reading this table directly.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_tool_calls_result_status_check'
      AND conrelid = 'public.mcp_tool_calls'::regclass
  ) THEN
    ALTER TABLE public.mcp_tool_calls
      ADD CONSTRAINT mcp_tool_calls_result_status_check
      CHECK (result_status IN ('ok', 'error', 'denied', 'refused'));
  END IF;
END $$;

-- Retention sweep. Called by the maintenance cron; safe to run at any time and
-- does nothing once the tail is clear.
--
-- GUARDED IN THE BODY, NOT BY A REVOKE. On this Postgres image a DENIED call
-- from a role in supautils.hint_roles (anon, authenticated, service_role)
-- segfaults the backend and restarts the database — US-2403, which is why
-- 00527 is permanently blocked. This function is in public, is volatile
-- plpgsql, and every argument has a default, so an argument-less
-- POST /rest/v1/rpc/sweep_mcp_tool_calls with the anon key that ships in the
-- browser bundle reaches that path. A revoke here would not protect the
-- function; it would publish a restart button. 00615 and 00617 made the same
-- call for the same reason. See
-- vault/20-domain/postgres-revoke-from-anon-is-a-noop.md.
--
-- auth.role() IS NULL is a direct psql session (no request GUC), which is the
-- operator applying migrations by hand; that is allowed deliberately.
CREATE OR REPLACE FUNCTION public.sweep_mcp_tool_calls(p_retain_days integer DEFAULT 400)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'sweep_mcp_tool_calls: service role required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.mcp_tool_calls
  WHERE created_at < now() - (p_retain_days || ' days')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- Self-record (US-1108) so the edge boot guard stays truthful however this ran.
insert into public.applied_migrations (version) values ('00619') on conflict do nothing;
