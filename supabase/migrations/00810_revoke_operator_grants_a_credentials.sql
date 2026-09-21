-- 00810: revoke the anon and authenticated grants on the operator tables that
-- never had them removed (US-3355, batch A of three, 12 tables).
--
-- THE FULL REASONING IS IN vault/20-domain/service-role-tables.md,
-- which owns this contract and carries the eleven-group classification, the
-- prod OpenAPI measurement and the before/after numbers. Kept short here on
-- purpose: an applied migration is immutable, so knowledge in this header could
-- never be corrected (US-2059).
--
-- In one paragraph: RLS with zero policies is the only layer on these tables.
-- No row is readable today, but prod's PostgREST OpenAPI document, fetched with
-- the anon key that ships in the browser bundle, advertises 87 of the 88 and
-- publishes 941 of their column names. A revoke takes the schema back and
-- restores the second layer, so one future CREATE POLICY is no longer the whole
-- distance to world-readable.
--
-- NO REVOKE ON FUNCTION, no `revoke all on all tables in schema public`, no
-- ALTER DEFAULT PRIVILEGES, no GRANT, no policy. 00527 is the parked precedent
-- and only half its reasoning transfers; the note explains which half.
--
-- Effect on existing rows: NONE. REVOKE rewrites pg_class.relacl. It takes a
-- brief ACCESS EXCLUSIVE lock per table that queues behind a long-running
-- query, so apply off-peak.
--
-- Idempotent: revoking a privilege that is not held raises nothing. Literal
-- statements rather than a loop, because service-role-grant-posture_test.ts
-- replays every GRANT and REVOKE in the corpus and its regex cannot see a name
-- inside a format() placeholder -- a loop would leave all 94 reading as
-- never-revoked. Every one of the 94 tables is created at or below 00789, which
-- is applied, so none can be absent here.

-- Group 1
revoke all on table public.cloud_storage_oauth_states from anon, authenticated;
revoke all on table public.google_oauth_states from anon, authenticated;
revoke all on table public.google_photos_import_sessions from anon, authenticated;
revoke all on table public.oauth_states from anon, authenticated;
revoke all on table public.phone_capture_photos from anon, authenticated;
revoke all on table public.phone_capture_sessions from anon, authenticated;
revoke all on table public.qbo_oauth_states from anon, authenticated;

-- Group 2
revoke all on table public.oauth_access_tokens from anon, authenticated;
revoke all on table public.oauth_authorization_codes from anon, authenticated;
revoke all on table public.oauth_clients from anon, authenticated;
revoke all on table public.oauth_grants from anon, authenticated;
revoke all on table public.oauth_refresh_tokens from anon, authenticated;

-- Readback inside the file, because "applied" and "took effect" are different
-- claims and the second one is cheap here.
do $$
declare
  still int;
begin
  select count(*) into still
    from unnest(array[
      'cloud_storage_oauth_states',
      'google_oauth_states',
      'google_photos_import_sessions',
      'oauth_states',
      'phone_capture_photos',
      'phone_capture_sessions',
      'qbo_oauth_states',
      'oauth_access_tokens',
      'oauth_authorization_codes',
      'oauth_clients',
      'oauth_grants',
      'oauth_refresh_tokens'
    ]) t
   where to_regclass('public.' || t) is not null
     and (has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'SELECT'));
  if still > 0 then
    raise exception '[00810] % of 12 tables still grant SELECT to anon or authenticated', still;
  end if;
  raise notice '[00810] all 12 tables are closed to anon and authenticated';
end;
$$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00810') on conflict do nothing;
