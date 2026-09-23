-- 00831: prove source_item_counts counts only what the caller may see.
--
-- The function is SECURITY INVOKER and takes p_user_id from the browser, so
-- the tenant boundary is inventory_items RLS, not the argument. This asserts
-- both directions: a stranger asking for A's workspace gets nothing, while A
-- and A's viewer member get the real per-source counts. A function that
-- returned nothing for everyone would pass the first half on its own.
--
-- Everything runs inside a transaction that ROLLS BACK. It writes nothing.
begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a831', 'a831@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b831', 'b831@example.com'),
  ('dddddddd-0000-0000-0000-00000000d831', 'v831@example.com')
  on conflict (id) do nothing;
insert into public.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a831', 'a831@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b831', 'b831@example.com'),
  ('dddddddd-0000-0000-0000-00000000d831', 'v831@example.com')
  on conflict (id) do nothing;
insert into public.workspace_members (owner_id, member_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a831', 'dddddddd-0000-0000-0000-00000000d831', 'viewer')
  on conflict do nothing;
insert into public.sources (id, user_id, name, source_type) values
  ('5ce00000-0000-0000-0000-0000000a0831', 'aaaaaaaa-0000-0000-0000-00000000a831', 'A Goodwill', 'other'),
  ('5ce00000-0000-0000-0000-0000000b0831', 'bbbbbbbb-0000-0000-0000-00000000b831', 'B Estate', 'other');

-- A: three items from A Goodwill and one with no source. B: two from B Estate.
insert into public.inventory_items (user_id, title, source_id)
select 'aaaaaaaa-0000-0000-0000-00000000a831', 'A item ' || g,
       '5ce00000-0000-0000-0000-0000000a0831'::uuid
  from generate_series(1, 3) g;
insert into public.inventory_items (user_id, title, source_id) values
  ('aaaaaaaa-0000-0000-0000-00000000a831', 'A unsourced', null);
insert into public.inventory_items (user_id, title, source_id)
select 'bbbbbbbb-0000-0000-0000-00000000b831', 'B item ' || g,
       '5ce00000-0000-0000-0000-0000000b0831'::uuid
  from generate_series(1, 2) g;

-- What a caller has. Deliberately NARROW (US-3350): select on the one table
-- the function reads, and execute on the function. anon gets both too, so
-- the anon case below is decided by RLS rather than by a missing grant.
grant usage on schema public, auth to anon, authenticated;
grant select on public.inventory_items to anon, authenticated;
grant execute on function public.source_item_counts(uuid) to anon, authenticated;

-- Prints the counts as "source_id:count,..." (NONE when there are no rows),
-- or REFUSED plus the SQLSTATE.
create function pg_temp.probe(p_label text, p_owner uuid)
returns void language plpgsql as $$
declare v text;
begin
  select coalesce(
           string_agg(c.source_id::text || ':' || c.item_count, ',' order by c.source_id),
           'NONE')
    into v
    from public.source_item_counts(p_owner) c;
  raise notice 'RESULT %=%', p_label, v;
exception when others then
  raise notice 'RESULT %=REFUSED_%', p_label, sqlstate;
end $$;
grant execute on function pg_temp.probe(text, uuid) to anon, authenticated;

set local role authenticated;

-- A reads A's own counts.
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000a831","role":"authenticated"}';
select pg_temp.probe('owner', 'aaaaaaaa-0000-0000-0000-00000000a831');

-- A's viewer reads A's counts (the Sources page for a workspace member).
set local request.jwt.claims =
  '{"sub":"dddddddd-0000-0000-0000-00000000d831","role":"authenticated"}';
select pg_temp.probe('member', 'aaaaaaaa-0000-0000-0000-00000000a831');

-- THE BOUNDARY: B names A's workspace and must see nothing.
set local request.jwt.claims =
  '{"sub":"bbbbbbbb-0000-0000-0000-00000000b831","role":"authenticated"}';
select pg_temp.probe('foreign', 'aaaaaaaa-0000-0000-0000-00000000a831');
-- B's own counts still work.
select pg_temp.probe('own', 'bbbbbbbb-0000-0000-0000-00000000b831');

-- anon can execute it (00831 deliberately has no REVOKE, see US-2403), so
-- what it gets back is what matters: nothing.
reset request.jwt.claims;
set local role anon;
select pg_temp.probe('anon', 'aaaaaaaa-0000-0000-0000-00000000a831');

reset role;

-- A definer would make the argument the only tenant check.
do $$
begin
  raise notice 'RESULT definer=%', (
    select p.prosecdef from pg_proc p
     where p.oid = 'public.source_item_counts(uuid)'::regprocedure);
end $$;

rollback;
