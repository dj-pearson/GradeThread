-- 00825: prove a key owner cannot raise their own API tier or clear their own
-- quota through PostgREST.
--
-- api-key-auth.ts trusts api_keys.rate_tier ('enterprise' = top tier) and
-- reads a NULL monthly_quota as unlimited. Before 00825 an owner-UPDATE policy
-- with no column limit, and two INSERT policies, let a signed-in client write
-- both columns directly.
--
-- The table privileges below are granted on purpose, so what refuses the
-- write is RLS (the thing 00825 changes) and not a missing grant.
--
-- IT PROVES BOTH DIRECTIONS: the owner can still read and delete their own
-- key, and the service role (the edge's POST /api/keys) can still insert one.
--
-- Everything runs inside a transaction that ROLLS BACK. It writes nothing.
begin;

-- A owns a capped key. M is A's workspace admin.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a825', 'a825@example.com'),
  ('cccccccc-0000-0000-0000-00000000c825', 'm825@example.com')
  on conflict (id) do nothing;
insert into public.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a825', 'a825@example.com'),
  ('cccccccc-0000-0000-0000-00000000c825', 'm825@example.com')
  on conflict (id) do nothing;
insert into public.workspace_members (owner_id, member_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a825', 'cccccccc-0000-0000-0000-00000000c825', 'admin')
  on conflict do nothing;
insert into public.api_keys (id, user_id, name, key_hash, key_prefix, monthly_quota, rate_tier)
values ('a9100000-0000-0000-0000-000000000825', 'aaaaaaaa-0000-0000-0000-00000000a825',
        'Capped key', 'hash-00825-a', 'gt_00825', 100, null);

grant usage on schema public, auth to authenticated, service_role;
grant select, insert, update, delete on public.api_keys to authenticated, service_role;
grant select on public.workspace_members to authenticated;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000a825","role":"authenticated"}';

-- THE HOLE: A lifts their own tier and clears their own cap. Without an UPDATE
-- policy RLS matches no row, so the answer is 0 rows rather than an error.
do $$
declare n int;
begin
  update public.api_keys set rate_tier = 'enterprise', monthly_quota = null
   where id = 'a9100000-0000-0000-0000-000000000825';
  get diagnostics n = row_count;
  raise notice 'RESULT owner_update_rows=%', n;
exception when others then
  raise notice 'RESULT owner_update_rows=REFUSED_%', sqlstate;
end $$;

-- A mints a row with no cap and the top tier.
do $$
begin
  insert into public.api_keys (user_id, name, key_hash, key_prefix, monthly_quota, rate_tier)
  values ('aaaaaaaa-0000-0000-0000-00000000a825', 'Self-minted', 'hash-00825-b',
          'gt_00825b', null, 'enterprise');
  raise notice 'RESULT owner_insert=ALLOWED';
exception when others then
  raise notice 'RESULT owner_insert=REFUSED_%', sqlstate;
end $$;

-- A can still see and delete their own key (the delete is undone below).
do $$
begin
  raise notice 'RESULT owner_select_rows=%', (select count(*) from public.api_keys
    where id = 'a9100000-0000-0000-0000-000000000825');
end $$;
savepoint before_delete;
do $$
declare n int;
begin
  delete from public.api_keys where id = 'a9100000-0000-0000-0000-000000000825';
  get diagnostics n = row_count;
  raise notice 'RESULT owner_delete_rows=%', n;
end $$;
rollback to savepoint before_delete;

-- A's workspace admin mints one for A.
set local request.jwt.claims =
  '{"sub":"cccccccc-0000-0000-0000-00000000c825","role":"authenticated"}';
do $$
begin
  insert into public.api_keys (user_id, name, key_hash, key_prefix, monthly_quota, rate_tier)
  values ('aaaaaaaa-0000-0000-0000-00000000a825', 'Admin-minted', 'hash-00825-c',
          'gt_00825c', null, 'enterprise');
  raise notice 'RESULT admin_insert=ALLOWED';
exception when others then
  raise notice 'RESULT admin_insert=REFUSED_%', sqlstate;
end $$;

-- The edge path: POST /api/keys inserts with the service-role client.
reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
do $$
begin
  insert into public.api_keys (user_id, name, key_hash, key_prefix)
  values ('aaaaaaaa-0000-0000-0000-00000000a825', 'Edge-minted', 'hash-00825-d', 'gt_00825d');
  raise notice 'RESULT service_insert=ALLOWED';
exception when others then
  raise notice 'RESULT service_insert=REFUSED_%', sqlstate;
end $$;

-- And the capped key is exactly as it was.
reset role;
do $$
begin
  raise notice 'RESULT key_after=%', (
    select coalesce(rate_tier, 'null') || '/' || coalesce(monthly_quota::text, 'null')
      from public.api_keys where id = 'a9100000-0000-0000-0000-000000000825');
end $$;

rollback;
