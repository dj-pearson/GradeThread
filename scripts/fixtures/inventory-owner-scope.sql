-- 00833 (INV-D1): prove the Inventory table and its tab counts read ONE
-- workspace, and refuse a caller who is not in it.
--
-- flipdesk_listing_page and inventory_status_counts are SECURITY INVOKER, and
-- the inventory_items SELECT policy admits the caller's own rows OR any
-- workspace they belong to. Before 00833 neither function filtered by owner, so
-- a seller in two workspaces saw both mixed in one table.
--
-- The shape here is exactly that seller: A owns items AND is a member of B's
-- workspace. M is a member of both. S is a stranger. A and B each sold an item
-- to the SAME buyer id, so a buyerCounts read that forgets the owner counts 2.
--
-- IT PROVES BOTH DIRECTIONS. A function that refused everyone would pass the
-- stranger case on its own, so the owner, both members and the service role
-- must all still get their rows.
--
-- Everything runs inside a transaction that ROLLS BACK. It writes nothing.
begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a833', 'a833@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b833', 'b833@example.com'),
  ('cccccccc-0000-0000-0000-00000000c833', 'm833@example.com'),
  ('dddddddd-0000-0000-0000-00000000d833', 's833@example.com')
  on conflict (id) do nothing;
insert into public.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a833', 'a833@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b833', 'b833@example.com'),
  ('cccccccc-0000-0000-0000-00000000c833', 'm833@example.com'),
  ('dddddddd-0000-0000-0000-00000000d833', 's833@example.com')
  on conflict (id) do nothing;

-- A is in B's workspace; M is in both.
insert into public.workspace_members (owner_id, member_id, role) values
  ('bbbbbbbb-0000-0000-0000-00000000b833', 'aaaaaaaa-0000-0000-0000-00000000a833', 'viewer'),
  ('aaaaaaaa-0000-0000-0000-00000000a833', 'cccccccc-0000-0000-0000-00000000c833', 'viewer'),
  ('bbbbbbbb-0000-0000-0000-00000000b833', 'cccccccc-0000-0000-0000-00000000c833', 'listing_manager')
  on conflict do nothing;

-- A: two items, one sold. B: one item, sold. Same buyer on both sales.
insert into public.inventory_items (id, user_id, title, status) values
  ('a1000000-0000-0000-0000-000000000833', 'aaaaaaaa-0000-0000-0000-00000000a833', 'A sold jacket', 'sold'),
  ('a2000000-0000-0000-0000-000000000833', 'aaaaaaaa-0000-0000-0000-00000000a833', 'A new shirt', 'acquired'),
  ('b1000000-0000-0000-0000-000000000833', 'bbbbbbbb-0000-0000-0000-00000000b833', 'B sold coat', 'sold');
insert into public.sales (inventory_item_id, user_id, sale_price, buyer_id) values
  ('a1000000-0000-0000-0000-000000000833', 'aaaaaaaa-0000-0000-0000-00000000a833', 40, 'shared-buyer-833'),
  ('b1000000-0000-0000-0000-000000000833', 'bbbbbbbb-0000-0000-0000-00000000b833', 50, 'shared-buyer-833');

-- What a signed-in caller has. Local only and rolled back with everything
-- else: items_full is security_invoker, so the caller needs SELECT on the
-- tables under it. Never read grant state off a stack after this.
grant usage on schema public, auth to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated, service_role;

-- One probe per call. Prints the shape of the answer, or REFUSED plus SQLSTATE.
--   total   = the pager's count
--   foreign = rows on the page whose user_id is not the expected owner
--   buyer   = buyerCounts for the shared buyer
create function pg_temp.page(p_label text, p_owner uuid, p_expect uuid)
returns void language plpgsql as $$
declare r jsonb;
begin
  r := public.flipdesk_listing_page(
    p_tab => 'all', p_limit => 100, p_offset => 0, p_owner_id => p_owner);
  raise notice 'RESULT %=total:%,foreign:%,buyer:%', p_label,
    r ->> 'total',
    (select count(*) from jsonb_array_elements(r -> 'rows') e
      where (e ->> 'user_id')::uuid is distinct from p_expect),
    coalesce(r -> 'buyerCounts' ->> 'shared-buyer-833', '0');
exception when others then
  raise notice 'RESULT %=REFUSED_%', p_label, sqlstate;
end $$;

create function pg_temp.counts(p_label text, p_owner uuid)
returns void language plpgsql as $$
declare r jsonb;
begin
  r := public.inventory_status_counts(p_owner);
  raise notice 'RESULT %=sold:%,acquired:%', p_label,
    coalesce(r ->> 'sold', '0'), coalesce(r ->> 'acquired', '0');
exception when others then
  raise notice 'RESULT %=REFUSED_%', p_label, sqlstate;
end $$;
grant execute on function pg_temp.page(text, uuid, uuid) to anon, authenticated, service_role;
grant execute on function pg_temp.counts(text, uuid) to anon, authenticated, service_role;

set local role authenticated;

-- A, in A's own workspace, and with no owner at all (an old client).
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000a833","role":"authenticated"}';
select pg_temp.page('owner_a', 'aaaaaaaa-0000-0000-0000-00000000a833', 'aaaaaaaa-0000-0000-0000-00000000a833');
select pg_temp.page('owner_a_null', null, 'aaaaaaaa-0000-0000-0000-00000000a833');
select pg_temp.counts('counts_owner_a', 'aaaaaaaa-0000-0000-0000-00000000a833');
select pg_temp.counts('counts_owner_a_null', null);
-- A switched into B's workspace.
select pg_temp.page('a_in_b', 'bbbbbbbb-0000-0000-0000-00000000b833', 'bbbbbbbb-0000-0000-0000-00000000b833');

-- M, a member of both, in each; and with no owner, M's own (empty) inventory.
set local request.jwt.claims =
  '{"sub":"cccccccc-0000-0000-0000-00000000c833","role":"authenticated"}';
select pg_temp.page('member_b', 'bbbbbbbb-0000-0000-0000-00000000b833', 'bbbbbbbb-0000-0000-0000-00000000b833');
select pg_temp.page('member_a', 'aaaaaaaa-0000-0000-0000-00000000a833', 'aaaaaaaa-0000-0000-0000-00000000a833');
select pg_temp.page('member_null', null, 'cccccccc-0000-0000-0000-00000000c833');
select pg_temp.counts('counts_member_b', 'bbbbbbbb-0000-0000-0000-00000000b833');

-- S, a stranger, naming A's workspace.
set local request.jwt.claims =
  '{"sub":"dddddddd-0000-0000-0000-00000000d833","role":"authenticated"}';
select pg_temp.page('stranger_a', 'aaaaaaaa-0000-0000-0000-00000000a833', 'aaaaaaaa-0000-0000-0000-00000000a833');
select pg_temp.counts('counts_stranger_a', 'aaaaaaaa-0000-0000-0000-00000000a833');

reset role;

-- anon, naming A's workspace.
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select pg_temp.page('anon_a', 'aaaaaaaa-0000-0000-0000-00000000a833', 'aaaaaaaa-0000-0000-0000-00000000a833');
reset role;

-- The service role, no sub, naming A's workspace.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.page('service_role_a', 'aaaaaaaa-0000-0000-0000-00000000a833', 'aaaaaaaa-0000-0000-0000-00000000a833');
reset role;

rollback;
