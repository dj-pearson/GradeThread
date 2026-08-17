-- 00614 — a session revocation that exists (US-2662).
--
-- The full finding lives in vault/10-ops/impersonation-session-revocation.md.
-- The short version: stopping an impersonation called
-- POST {SUPABASE_URL}/auth/v1/admin/users/{id}/logout, and that route does not
-- exist on the GoTrue this project runs. Every call 404s, so nothing was ever
-- revoked and /stop reported sessions_revoked:false while the UI showed a clean
-- stop.
--
-- This is the mechanism we own instead. Refresh tokens hang off auth.sessions by
-- a foreign key with ON DELETE CASCADE (refresh_tokens_session_id_fkey, read
-- from pg_constraint), so deleting a user's session rows takes their refresh
-- tokens with them. Measured on GoTrue v2.195.0, control first: a refresh with a
-- live session returned 200; after deleting the rows the same token returned 400
-- refresh_token_not_found.
--
-- WHY A FUNCTION AND NOT A DIRECT DELETE FROM THE EDGE: PostgREST only exposes
-- the schemas in its config, which is public and storage (supabase/config.toml).
-- supabaseAdmin.schema("auth").from("sessions").delete() type-checks, lints
-- clean, and answers 406 at runtime.

create or replace function public.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  deleted integer;
begin
  -- The caller allowlist required of every SECURITY DEFINER function here; see
  -- vault/20-domain/security-definer-caller-allowlist.md. Positive form on
  -- purpose: `if auth.uid() is not null and not is_admin()` reads as a check and
  -- lets an anonymous caller through, because an anonymous caller has no uid.
  if not (auth.role() = 'service_role') then
    raise exception 'revoke_user_sessions: service role required'
      using errcode = '42501';
  end if;

  if p_user_id is null then
    return 0;
  end if;

  delete from auth.sessions where user_id = p_user_id;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

comment on function public.revoke_user_sessions(uuid) is
  'US-2662: delete a user''s auth.sessions (refresh tokens cascade). Service role only. Replaces the GoTrue admin logout route, which does not exist on this version.';

-- The explicit grant decision US-2282 AC4 requires. Naming the role that calls
-- this is the point; silence would mean "whatever Supabase's ALTER DEFAULT
-- PRIVILEGES bootstrap decided", which on this stack is anon and authenticated.
grant execute on function public.revoke_user_sessions(uuid) to service_role;

-- ⚠ THERE IS DELIBERATELY NO MATCHING REVOKE, and this is the one place the
-- usual advice is actively dangerous. A permission-DENIED function call from a
-- role in supautils.hint_roles segfaults this Postgres image and restarts the
-- database (US-2403), so revoking EXECUTE from anon would convert a leak into a
-- restart button reachable with the public key. The grant above is a
-- declaration; the control is the guard in the body, which raises an ordinary
-- 42501 instead. See vault/20-domain/security-definer-caller-allowlist.md.

-- ── Prove it actually took effect ──────────────────────────────────────────
--
-- CREATE OR REPLACE only replaces a function with the SAME argument list. A
-- different signature creates a SECOND OVERLOAD and leaves the original live,
-- producing a migration recorded as applied whose behaviour never changed. See
-- vault/10-ops/migrations-process.md.
do $verify_00614$
declare
  found_guard boolean;
begin
  select bool_and(p.prosrc like '%auth.role()%')
    into found_guard
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'revoke_user_sessions';

  if found_guard is not true then
    raise exception
      '00614 did NOT take effect: public.revoke_user_sessions is missing or unguarded.'
      using errcode = 'check_violation';
  end if;
end
$verify_00614$;

insert into public.applied_migrations (version) values ('00614') on conflict do nothing;
