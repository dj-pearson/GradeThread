-- US-2662: a revocation mechanism that exists.
--
-- Stopping impersonation calls GoTrue's POST /admin/users/{id}/logout, and that
-- route is ABSENT in GoTrue v2.195.0: it answers 404, measured against a running
-- container with the controls that make the result mean something (GET
-- /admin/users/{id} answers 200, so auth and routing and the id are all fine;
-- POST /logout answers 403 rather than 404, which is how you tell the admin
-- variant is genuinely missing rather than merely unauthorised). auth.sessions
-- for that user stayed at 2 rows across the attempt. So every stop returned
-- sessions_revoked: false and the admin's copy of the target's refresh token
-- stayed live for its full lifetime.
--
-- WHAT DOES WORK, measured on the same container with the control first:
--   refresh with a live session   -> 200 accepted
--   delete auth.sessions for user -> 5 rows
--   refresh with the same token   -> 400 refresh_token_not_found
-- Refresh tokens hang off sessions, so removing the rows invalidates them.
--
-- WHY THIS NEEDS A FUNCTION rather than a client call: PostgREST only exposes
-- the schemas in its config (supabase/config.toml:5 lists public and storage),
-- so supabaseAdmin.schema('auth').from('sessions').delete() type-checks, lints
-- clean and answers 406. A SECURITY DEFINER function in `public` is the shape
-- that reaches auth. The owner (postgres) is not a superuser here but does hold
-- DELETE on both auth tables, verified rather than assumed.
--
-- NO REVOKE, deliberately, and this is US-2666's lesson applied rather than
-- restated: a denied call from anon or authenticated segfaults this Postgres
-- image (US-2403), and `REVOKE ... FROM anon` alone is a no-op anyway because
-- the CREATE FUNCTION grant to PUBLIC survives it. The authorization check lives
-- in the body, which raises an ordinary 42501 and arms neither problem.
-- See vault/20-domain/postgres-revoke-from-anon-is-a-noop.md.
--
-- auth.refresh_tokens.user_id is varchar, not uuid; the cast is required.

CREATE OR REPLACE FUNCTION public.admin_revoke_user_sessions(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_sessions int;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'admin_revoke_user_sessions: service role required'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Tokens first: a row here without its session is the state we never want to
  -- leave behind if the second statement were ever to fail.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::text;

  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  RETURN v_sessions;
END;
$fn$;

COMMENT ON FUNCTION public.admin_revoke_user_sessions(uuid) IS
  'US-2662: delete a user''s auth sessions and refresh tokens, returning the session count. '
  'Service-role only, checked in the body. Replaces GoTrue POST /admin/users/{id}/logout, '
  'which does not exist in v2.195.0.';

-- AN EXPLICIT GRANT, AND DELIBERATELY NOT A REVOKE. The two are not symmetric
-- here. A REVOKE arms the US-2403 segfault on a denied call; a GRANT denies
-- nobody and cannot. What it buys is the thing US-2666 found missing on five of
-- the six functions it fixed: they hold EXECUTE only THROUGH the PUBLIC default,
-- with no grant to service_role anywhere, so any later `REVOKE ... FROM PUBLIC`
-- would silently strip the edge's own access. This line means that cannot happen
-- to this function. It also answers US-2282 AC4's guard, which asks every
-- SECURITY DEFINER function to say who may execute it -- the restriction itself
-- is the check in the body above.
GRANT EXECUTE ON FUNCTION public.admin_revoke_user_sessions(uuid) TO service_role;

insert into public.applied_migrations (version) values ('00612') on conflict do nothing;
