-- 00835: prove flipdesk_search_v2 searches ONE workspace, filters before it
-- ranks and limits, and refuses a caller who is not in that workspace.
--
-- flipdesk_search (v1) is SECURITY INVOKER with no owner predicate, and the
-- SELECT policies admit the caller's own rows OR any workspace they belong to.
-- So for a member of two workspaces it ranked both, stopped at the limit, and
-- the web client then dropped the other workspace's rows. When one workspace
-- is much bigger, its rows fill the page first and the small one's are gone.
--
-- The shape is exactly that crowd-out. A owns 3 items, 1 listing and 1 sale
-- that match "jacket". B owns 60 matching items plus 1 listing and 1 sale, all
-- ranked ABOVE A's (short titles score a higher trigram similarity). M is a
-- member of both. S is a stranger. Every call asks for 51 rows, what the web
-- client asks for. v1 as M returns 51 of B's rows and none of A's; v2 as M in
-- A must return all 5 of A's.
--
-- IT PROVES BOTH DIRECTIONS. A function that refused everyone would pass the
-- stranger case on its own, so the owner, the member and the service role must
-- all still get their rows.
--
-- Everything runs inside a transaction that ROLLS BACK. It writes nothing.
begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a835', 'a835@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b835', 'b835@example.com'),
  ('cccccccc-0000-0000-0000-00000000c835', 'm835@example.com'),
  ('dddddddd-0000-0000-0000-00000000d835', 's835@example.com')
  on conflict (id) do nothing;
insert into public.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a835', 'a835@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b835', 'b835@example.com'),
  ('cccccccc-0000-0000-0000-00000000c835', 'm835@example.com'),
  ('dddddddd-0000-0000-0000-00000000d835', 's835@example.com')
  on conflict (id) do nothing;

-- M is in both workspaces. A is in neither of the others.
insert into public.workspace_members (owner_id, member_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a835', 'cccccccc-0000-0000-0000-00000000c835', 'viewer'),
  ('bbbbbbbb-0000-0000-0000-00000000b835', 'cccccccc-0000-0000-0000-00000000c835', 'viewer')
  on conflict do nothing;

-- Item ids start with 'a' for A and 'b' for B, which is how the probe counts
-- whose rows came back (every result carries inventory_item_id).
-- A: three long-titled items (low trigram similarity), plus one unrelated.
insert into public.inventory_items (id, user_id, title, status) values
  ('a1000000-0000-0000-0000-000000000835', 'aaaaaaaa-0000-0000-0000-00000000a835', 'Vintage waxed cotton field jacket olive', 'acquired'),
  ('a2000000-0000-0000-0000-000000000835', 'aaaaaaaa-0000-0000-0000-00000000a835', 'Heavy wool blend chore jacket navy', 'acquired'),
  ('a3000000-0000-0000-0000-000000000835', 'aaaaaaaa-0000-0000-0000-00000000a835', 'Quilted nylon liner jacket black', 'sold'),
  ('a4000000-0000-0000-0000-000000000835', 'aaaaaaaa-0000-0000-0000-00000000a835', 'Plain cotton tee', 'acquired');
insert into public.listings (user_id, inventory_item_id, platform, listing_price, listing_title) values
  ('aaaaaaaa-0000-0000-0000-00000000a835', 'a1000000-0000-0000-0000-000000000835', 'ebay', 40,
   'Vintage waxed cotton field jacket olive size large');
insert into public.sales (user_id, inventory_item_id, sale_price, buyer_username, buyer_notes) values
  ('aaaaaaaa-0000-0000-0000-00000000a835', 'a3000000-0000-0000-0000-000000000835', 30,
   'liner_buyer', 'asked whether the jacket liner zips out');

-- B: sixty short-titled items, which outrank every A row.
insert into public.inventory_items (id, user_id, title, status)
select ('b' || lpad(n::text, 7, '0') || '-0000-0000-0000-000000000835')::uuid,
       'bbbbbbbb-0000-0000-0000-00000000b835', 'Jacket ' || n, 'acquired'
from generate_series(1, 60) n;
insert into public.listings (user_id, inventory_item_id, platform, listing_price, listing_title) values
  ('bbbbbbbb-0000-0000-0000-00000000b835', 'b0000001-0000-0000-0000-000000000835', 'ebay', 20, 'Jacket');
insert into public.sales (user_id, inventory_item_id, sale_price, buyer_username, buyer_notes) values
  ('bbbbbbbb-0000-0000-0000-00000000b835', 'b0000002-0000-0000-0000-000000000835', 20,
   'jacket', 'jacket');

-- What a signed-in caller has. Local only and rolled back with everything
-- else. Never read grant state off a stack after this.
grant usage on schema public, auth to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated, service_role;

-- One probe per call: how many rows, and how many are A's and B's. Or REFUSED
-- plus the SQLSTATE.
create function pg_temp.sr(p_label text, p_owner uuid, p_v1 boolean default false)
returns void language plpgsql as $$
declare n int; na int; nb int;
begin
  if p_v1 then
    select count(*), count(*) filter (where left(r.inventory_item_id::text, 1) = 'a'),
           count(*) filter (where left(r.inventory_item_id::text, 1) = 'b')
      into n, na, nb
      from public.flipdesk_search('jacket', 'all', 51) r;
  else
    select count(*), count(*) filter (where left(r.inventory_item_id::text, 1) = 'a'),
           count(*) filter (where left(r.inventory_item_id::text, 1) = 'b')
      into n, na, nb
      from public.flipdesk_search_v2('jacket', 'all', 51, 0.3, p_owner) r;
  end if;
  raise notice 'RESULT %=n:%,a:%,b:%', p_label, n, na, nb;
exception when others then
  raise notice 'RESULT %=REFUSED_%', p_label, sqlstate;
end $$;
grant execute on function pg_temp.sr(text, uuid, boolean) to anon, authenticated, service_role;

set local role authenticated;

-- A, naming A, with no owner (NULL = own rows), and naming B (not a member).
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000a835","role":"authenticated"}';
select pg_temp.sr('owner_a', 'aaaaaaaa-0000-0000-0000-00000000a835');
select pg_temp.sr('owner_a_null', null);
select pg_temp.sr('owner_a_names_b', 'bbbbbbbb-0000-0000-0000-00000000b835');
select pg_temp.sr('v1_owner_a', null, true);

-- M, a member of both: B, then A (the crowd-out case), then its own (empty).
set local request.jwt.claims =
  '{"sub":"cccccccc-0000-0000-0000-00000000c835","role":"authenticated"}';
select pg_temp.sr('member_b', 'bbbbbbbb-0000-0000-0000-00000000b835');
select pg_temp.sr('member_a', 'aaaaaaaa-0000-0000-0000-00000000a835');
select pg_temp.sr('member_null', null);
select pg_temp.sr('v1_member', null, true);

-- S, a stranger, naming A, and with no owner.
set local request.jwt.claims =
  '{"sub":"dddddddd-0000-0000-0000-00000000d835","role":"authenticated"}';
select pg_temp.sr('stranger_a', 'aaaaaaaa-0000-0000-0000-00000000a835');
select pg_temp.sr('stranger_null', null);
select pg_temp.sr('v1_stranger', null, true);

reset role;

-- anon, naming A, and with no owner.
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select pg_temp.sr('anon_a', 'aaaaaaaa-0000-0000-0000-00000000a835');
select pg_temp.sr('anon_null', null);
reset role;

-- The service role, no sub, naming A, and with no owner.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.sr('service_role_a', 'aaaaaaaa-0000-0000-0000-00000000a835');
select pg_temp.sr('service_role_null', null);
reset role;

rollback;
