-- 00720_ebay_api_calls_no_revoke.sql
--
-- Remove the crash surface 00711 added, without opening the hole the revoke was
-- there to close. Same problem, same fix, same reasoning as 00686 did for
-- 00685; vault/20-domain/postgres-revoke-from-anon-is-a-noop.md owns it.
--
-- WHAT WAS WRONG. 00711 ended with
--     REVOKE ALL ON FUNCTION public.bump_ebay_api_calls(JSONB) FROM PUBLIC;
-- plus a guarded revoke from anon and authenticated. On this Postgres image a
-- DENIED function call from a role in supautils.hint_roles SEGFAULTS the
-- backend and restarts the database, because supautils appends a GRANT hint to
-- the error (US-2403). anon is the key that ships in the browser bundle and
-- PostgREST exposes this function at /rpc/bump_ebay_api_calls, so the revoke
-- put a database restart one unauthenticated request away.
--
-- DELIBERATELY NO REVOKE HERE. Restoring the default EXECUTE is the posture
-- every other function in this schema has; the permission question is answered
-- in the function BODY, which raises an ordinary 42501 and arms nothing.
--
-- The body check is stricter than the revoke was: only the service role may
-- write API-call accounting. Nothing user-facing calls this function -- the
-- edge writes it with the service-role client -- so a signed-in seller has no
-- legitimate path here either.
--
-- Idempotent: CREATE OR REPLACE, and a GRANT that is a no-op when already held.

CREATE OR REPLACE FUNCTION public.bump_ebay_api_calls(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_applied INTEGER := 0;
BEGIN
  -- The authorization check, in the body. auth.role() is NULL for a direct
  -- psql/session call (an operator or a migration), which stays allowed; a
  -- request that arrives through PostgREST always carries one.
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'bump_ebay_api_calls: service role only'
      USING ERRCODE = '42501';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN 0;
  END IF;

  INSERT INTO public.ebay_api_call_daily AS d
    (day, api, endpoint, method, status_class, calls)
  SELECT
    (r->>'day')::DATE,
    LEFT(r->>'api', 40),
    LEFT(r->>'endpoint', 200),
    LEFT(r->>'method', 10),
    LEFT(r->>'status_class', 10),
    GREATEST((r->>'calls')::BIGINT, 0)
  FROM jsonb_array_elements(p_rows) AS r
  WHERE r->>'day' IS NOT NULL
    AND r->>'api' IS NOT NULL
    AND r->>'endpoint' IS NOT NULL
    AND r->>'method' IS NOT NULL
    AND r->>'status_class' IS NOT NULL
  ON CONFLICT ON CONSTRAINT ebay_api_call_daily_pk DO UPDATE
    SET calls = d.calls + EXCLUDED.calls,
        updated_at = NOW();

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  RETURN v_applied;
END;
$$;

-- Restore the default EXECUTE that 00711 took away. This is what disarms the
-- crash: a role that HOLDS execute never takes the denial path.
GRANT EXECUTE ON FUNCTION public.bump_ebay_api_calls(JSONB) TO PUBLIC;

COMMENT ON FUNCTION public.bump_ebay_api_calls(JSONB) IS
  'US-3042 accounting writer. EXECUTE is public by default (revoking it crashes this Postgres image); the service-role check is in the body.';

insert into public.applied_migrations (version) values ('00720') on conflict do nothing;
