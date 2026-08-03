-- US-2349 AC1/AC2: prove the audit log is neither writable nor readable by an
-- authenticated admin, while the paths that must keep working still do.
--
-- Run against a stack with the migration corpus applied. Everything happens
-- inside one transaction and rolls back.
--
-- TWO THINGS THIS SCRIPT HAS TO GET RIGHT, and the first one caught me out.
--
-- 1. IT MUST GRANT FIRST. A local `supabase db reset` gives `authenticated` and
--    `service_role` no SELECT/INSERT on ANY public table — `human_reviews`,
--    untouched by this work, is in the same state. So a run without these
--    grants "blocks" the forgery for a reason that has nothing to do with the
--    fix, and could not tell 00520's policy removal apart from a grant that was
--    never there. Prod's Supabase defaults DO grant them, which is exactly why
--    the bug was real there. Granting here reproduces prod and leaves the
--    policy as the only thing under test.
--
-- 2. IT MUST IMPERSONATE PROPERLY. `set local role` plus a
--    `request.jwt.claims` GUC is what PostgREST does per request, so `auth.uid()`
--    and `is_admin()` resolve as they would for a real session. Running as the
--    superuser would prove nothing: a superuser bypasses RLS, so every policy
--    looks permissive.
\set ON_ERROR_STOP on
begin;

grant select, insert on public.admin_audit_log to authenticated;
grant select, insert on public.admin_audit_log to service_role;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at)
values ('7a000000-0000-4000-8000-0000000000a1',
        '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'plain-admin@t.test', 'x', now()),
       ('7a000000-0000-4000-8000-0000000000a2',
        '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'the-super@t.test', 'x', now());

update public.users set role = 'admin'       where id = '7a000000-0000-4000-8000-0000000000a1';
update public.users set role = 'super_admin' where id = '7a000000-0000-4000-8000-0000000000a2';

\echo '=== policies on admin_audit_log (expect ZERO rows) ==='
select policyname, cmd from pg_policies
 where schemaname = 'public' and tablename = 'admin_audit_log';

\echo '=== RLS is still enabled (expect t — no policies AND no RLS would be wide open) ==='
select relrowsecurity from pg_class where oid = 'public.admin_audit_log'::regclass;

-- ── The edge writer: service_role, which bypasses RLS ───────────────────────
set local role service_role;
insert into public.admin_audit_log (admin_user_id, action, target_type)
values ('7a000000-0000-4000-8000-0000000000a2', 'billing.refund', 'user');
reset role;

\echo '=== the edge (service_role) can still WRITE (expect 1) ==='
select count(*) as edge_writes from public.admin_audit_log where action = 'billing.refund';

-- ── Now act as a plain admin, exactly as PostgREST would ────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"7a000000-0000-4000-8000-0000000000a1","role":"authenticated"}';

\echo '=== is_admin() agrees this session IS an admin (expect t) ==='
select public.is_admin();

\echo '=== THE FORGERY: write a row naming the super_admin (expect: blocked by RLS) ==='
do $$
begin
  insert into public.admin_audit_log (admin_user_id, action, target_type)
  values ('7a000000-0000-4000-8000-0000000000a2', 'users.role_change', 'user');
  raise notice 'FORGERY SUCCEEDED — the audit log is writable from a browser again';
exception when others then
  raise notice 'blocked: % (%)', sqlerrm, sqlstate;
end $$;

\echo '=== THE READ: select the table directly (expect 0 — RLS with no policy) ==='
select count(*) as visible_to_a_plain_admin from public.admin_audit_log;

reset role;
\echo '=== the row really is there, so 0 above is a refusal and not an empty table (expect 1) ==='
select count(*) as rows_actually_present from public.admin_audit_log
 where action = 'billing.refund';

rollback;
