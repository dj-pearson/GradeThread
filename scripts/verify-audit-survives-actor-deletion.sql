-- US-2350 AC2: prove that audit rows survive deletion of the acting admin.
--
-- Run against the throwaway local stack AFTER the migration corpus applies.
-- Everything happens inside one transaction and rolls back, so the database is
-- untouched either way.
\set ON_ERROR_STOP on
begin;

-- An admin who is about to author some audit rows and then delete themselves.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at)
values ('7a000000-0000-4000-8000-00000000dead',
        '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'leaving-admin@t.test', 'x', now());

update public.users
   set role = 'admin', email = 'leaving-admin@t.test'
 where id = '7a000000-0000-4000-8000-00000000dead';

\echo '=== the FK action (expect: n = SET NULL. c would be the CASCADE bug; a is NO ACTION) ==='
select confdeltype
  from pg_constraint
 where conrelid = 'public.admin_audit_log'::regclass
   and conname  = 'admin_audit_log_admin_user_id_fkey';

-- Two rows written the way the edge writes them: no actor_email supplied, so
-- the trigger has to fill it. That is the half that makes SET NULL useful.
insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, details)
values ('7a000000-0000-4000-8000-00000000dead', 'billing.refund', 'user', null, '{"amount":9900}'),
       ('7a000000-0000-4000-8000-00000000dead', 'users.role_change', 'user', null, '{"to":"admin"}');

\echo '=== the trigger stamped identity at write time (expect 2 rows, email + role filled) ==='
select action, actor_email, actor_role
  from public.admin_audit_log
 where admin_user_id = '7a000000-0000-4000-8000-00000000dead'
 order by action;

\echo '=== now delete the admin — the exact cascade path account/delete takes ==='
delete from auth.users where id = '7a000000-0000-4000-8000-00000000dead';

\echo '=== the public.users row is gone (expect 0) ==='
select count(*) from public.users where id = '7a000000-0000-4000-8000-00000000dead';

\echo '=== THE POINT: the audit rows SURVIVED (expect 2, not 0) ==='
select count(*) as surviving_rows
  from public.admin_audit_log
 where actor_email = 'leaving-admin@t.test';

\echo '=== and they are still attributable (expect the email + role, admin_user_id NULL) ==='
select action, admin_user_id, actor_email, actor_role
  from public.admin_audit_log
 where actor_email = 'leaving-admin@t.test'
 order by action;

rollback;
