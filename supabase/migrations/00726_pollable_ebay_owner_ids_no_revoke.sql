-- 00726_pollable_ebay_owner_ids_no_revoke.sql
--
-- Remove the crash surface 00724 added, without opening the hole the revoke was
-- there to close. Third time for this exact shape: 00686 did it for 00685,
-- 00720 did it for 00711, and this does it for 00724.
-- vault/20-domain/postgres-revoke-from-anon-is-a-noop.md owns the reasoning.
--
-- WHAT WAS WRONG. 00724 ended with
--     revoke all on function public.pollable_ebay_owner_ids(timestamptz)
--       from public;   -- and again from anon, and again from authenticated
--     grant execute on function public.pollable_ebay_owner_ids(timestamptz)
--       to service_role;
-- On this Postgres image a DENIED function call from a role in
-- supautils.hint_roles SEGFAULTS the backend and restarts the database, because
-- supautils appends a GRANT hint to the permission error (US-2403). anon is the
-- key that ships in the browser bundle and PostgREST exposes the function at
-- /rpc/pollable_ebay_owner_ids, so the revoke put a database restart one
-- unauthenticated request away.
--
-- WHAT IS AND IS NOT AT RISK, measured rather than assumed. PRODUCTION DOES NOT
-- REPRODUCE: current_setting('supautils.hint_roles', true) reads NULL on the
-- prod image (US-2403 AC1/AC6, read read-only over SSH 2026-09-02), so the
-- denied call there returns an ordinary error. The LOCAL image DOES reproduce
-- (scripts/db-denied-rpc-crash-check.mjs, three independent signals). So this
-- migration is not an incident response; it is removing a landmine that an
-- image upgrade would arm, and getting src/test/us2403-function-revoke-gate.ts
-- back to green so the NEXT one is caught on the day it lands.
--
-- DELIBERATELY NO REVOKE HERE. Restoring the default EXECUTE is the posture
-- every other function in this schema has; the permission question is answered
-- in the function BODY, which raises an ordinary 42501 and arms nothing.
--
-- The body check is stricter than the revoke was, and it has to be: this
-- function returns OTHER TENANTS' owner ids by design, so a signed-in seller
-- reaching it would be a tenant-isolation break, not merely an information
-- leak. Only the service role may call it. Nothing user-facing does -- the
-- marketplace-event sweep calls it with the service-role client.
--
-- Idempotent: create or replace, and a grant that is a no-op when already held.

create or replace function public.pollable_ebay_owner_ids(p_since timestamptz)
returns table (owner_user_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- The authorization check, in the body. auth.role() is null for a direct
  -- psql/session call (an operator or a migration), which stays allowed; a
  -- request that arrives through PostgREST always carries one.
  if auth.role() is not null and auth.role() <> 'service_role' then
    raise exception 'pollable_ebay_owner_ids: service role only'
      using errcode = '42501';
  end if;

  return query
  select c.user_id
  from public.marketplace_connections c
  where c.marketplace = 'ebay'
    and c.is_active
    and (
      exists (
        select 1 from public.listings l
        where l.user_id = c.user_id and l.platform = 'ebay' and l.is_active
      )
      or exists (
        select 1 from public.sales s
        where s.user_id = c.user_id and s.created_at >= p_since
      )
      or exists (
        select 1 from public.marketplace_post_sale_cases k
        where k.user_id = c.user_id and k.closed_at is null
      )
    )
  group by c.user_id;
end;
$$;

-- Restore the default EXECUTE that 00724 took away. This is what disarms the
-- crash: a role that HOLDS execute never takes the denial path. service_role
-- already holds it from 00724 and this is a no-op for that role.
grant execute on function public.pollable_ebay_owner_ids(timestamptz) to public;

comment on function public.pollable_ebay_owner_ids(timestamptz) is
  'US-3110 marketplace-event sweep gate. EXECUTE is public by default (revoking it crashes this Postgres image); the service-role check is in the body, and it must stay there because this function returns other tenants'' owner ids.';

insert into public.applied_migrations (version) values ('00726') on conflict do nothing;
