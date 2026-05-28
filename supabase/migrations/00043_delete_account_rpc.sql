-- Self-service account deletion (US-194, App Store Guideline 5.1.1(v)).
--
-- The iOS app (and web) need a way for a signed-in user to permanently
-- delete their own account. The client can't call auth.admin.deleteUser
-- (that needs the service-role key, which never ships to a client), so
-- we expose a SECURITY DEFINER RPC that deletes ONLY the caller's own
-- auth.users row. Everything downstream is wiped by the existing
-- ON DELETE CASCADE chain rooted at public.users.id -> auth.users.id
-- (see 00001_initial_schema.sql) and every table that cascades from
-- public.users / auth.users in turn.

CREATE OR REPLACE FUNCTION public.delete_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- Pin search_path so a malicious session-level search_path can't shadow
-- auth.users with a lookalike table (standard SECURITY DEFINER hardening).
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  caller uuid := auth.uid();
BEGIN
  -- No anon / service calls: this RPC only ever deletes the *caller's*
  -- own account, identified by their JWT. A NULL uid means no valid
  -- session, so refuse rather than risk an unscoped delete.
  IF caller IS NULL THEN
    RAISE EXCEPTION 'delete_account requires an authenticated user'
      USING errcode = '28000';
  END IF;

  -- Deleting the auth.users row cascades to public.users and onward
  -- through every FK declared ON DELETE CASCADE (inventory_items,
  -- listings, sales, item_photos, marketplace_connections, feedback,
  -- etc.). No need to enumerate child tables here — the schema owns
  -- that contract.
  DELETE FROM auth.users WHERE id = caller;
END;
$$;

-- Lock it down: not callable by anon, only by an authenticated session.
REVOKE ALL ON FUNCTION public.delete_account() FROM public;
REVOKE ALL ON FUNCTION public.delete_account() FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_account() TO authenticated;

COMMENT ON FUNCTION public.delete_account() IS
  'Permanently deletes the calling user''s own account (auth.users row + all cascaded data). Used by the iOS/web "Delete account" flow. SECURITY DEFINER; scoped to auth.uid() so a user can only ever delete themselves.';
