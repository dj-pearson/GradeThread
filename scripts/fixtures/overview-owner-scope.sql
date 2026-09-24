-- 00834: prove the FlipDesk Overview reads ONE workspace, refuses a caller who
-- is not in it, and lists only completed sales under recentSales.
--
-- flipdesk_overview_metrics is SECURITY INVOKER, and the items_full SELECT
-- policy admits the caller's own rows OR any workspace they belong to. Before
-- 00834 it did not filter by owner, so a seller in two workspaces saw both
-- blended on /dashboard.
--
-- The shape is exactly that seller: A owns items AND is a member of B's
-- workspace. M is a member of both. S is a stranger. A has one completed sale,
-- one refunded sale and one unsold item; B has one completed sale. So a read
-- that forgets the owner answers total:4, sold:2, gross:90, and a recentSales
-- that forgets the sale status lists the refunded one.
--
-- IT PROVES BOTH DIRECTIONS. A function that refused everyone would pass the
-- stranger case on its own, so the owner, both members and the service role
-- must all still get their numbers.
--
-- Everything runs inside a transaction that ROLLS BACK. It writes nothing.
begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a834', 'a834@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b834', 'b834@example.com'),
  ('cccccccc-0000-0000-0000-00000000c834', 'm834@example.com'),
  ('dddddddd-0000-0000-0000-00000000d834', 's834@example.com')
  on conflict (id) do nothing;
insert into public.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a834', 'a834@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b834', 'b834@example.com'),
  ('cccccccc-0000-0000-0000-00000000c834', 'm834@example.com'),
  ('dddddddd-0000-0000-0000-00000000d834', 's834@example.com')
  on conflict (id) do nothing;

-- A is in B's workspace; M is in both.
insert into public.workspace_members (owner_id, member_id, role) values
  ('bbbbbbbb-0000-0000-0000-00000000b834', 'aaaaaaaa-0000-0000-0000-00000000a834', 'viewer'),
  ('aaaaaaaa-0000-0000-0000-00000000a834', 'cccccccc-0000-0000-0000-00000000c834', 'viewer'),
  ('bbbbbbbb-0000-0000-0000-00000000b834', 'cccccccc-0000-0000-0000-00000000c834', 'listing_manager')
  on conflict do nothing;

-- A: one completed sale, one refunded sale, one unsold. B: one completed sale.
insert into public.inventory_items (id, user_id, title, status) values
  ('a1000000-0000-0000-0000-000000000834', 'aaaaaaaa-0000-0000-0000-00000000a834', 'A sold jacket', 'sold'),
  ('a2000000-0000-0000-0000-000000000834', 'aaaaaaaa-0000-0000-0000-00000000a834', 'A new shirt', 'acquired'),
  ('a3000000-0000-0000-0000-000000000834', 'aaaaaaaa-0000-0000-0000-00000000a834', 'A refunded hat', 'returned'),
  ('b1000000-0000-0000-0000-000000000834', 'bbbbbbbb-0000-0000-0000-00000000b834', 'B sold coat', 'sold');
insert into public.sales (inventory_item_id, user_id, sale_price, status) values
  ('a1000000-0000-0000-0000-000000000834', 'aaaaaaaa-0000-0000-0000-00000000a834', 40, 'completed'),
  ('a3000000-0000-0000-0000-000000000834', 'aaaaaaaa-0000-0000-0000-00000000a834', 30, 'refunded'),
  ('b1000000-0000-0000-0000-000000000834', 'bbbbbbbb-0000-0000-0000-00000000b834', 50, 'completed');

-- What a signed-in caller has. Local only and rolled back with everything
-- else: items_full is security_invoker, so the caller needs SELECT on the
-- tables under it. Never read grant state off a stack after this.
grant usage on schema public, auth to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated, service_role;

-- One probe per call. Prints the shape of the answer, or REFUSED plus SQLSTATE.
--   total  = items counted
--   sold   = soldInRange (completed sales)
--   gross  = grossInRange
--   recent = recentSales rows
create function pg_temp.ov(p_label text, p_owner uuid)
returns void language plpgsql as $$
declare r jsonb;
begin
  r := public.flipdesk_overview_metrics(p_owner_id => p_owner);
  raise notice 'RESULT %=total:%,sold:%,gross:%,recent:%', p_label,
    r ->> 'total',
    r ->> 'soldInRange',
    (r ->> 'grossInRange')::numeric::int,
    jsonb_array_length(r -> 'recentSales');
exception when others then
  raise notice 'RESULT %=REFUSED_%', p_label, sqlstate;
end $$;
grant execute on function pg_temp.ov(text, uuid) to anon, authenticated, service_role;

set local role authenticated;

-- A, in A's own workspace, with no owner (an old client), and inside B's.
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000a834","role":"authenticated"}';
select pg_temp.ov('owner_a', 'aaaaaaaa-0000-0000-0000-00000000a834');
select pg_temp.ov('owner_a_null', null);
select pg_temp.ov('a_in_b', 'bbbbbbbb-0000-0000-0000-00000000b834');

-- M, a member of both, in each; and with no owner, M's own (empty) account.
set local request.jwt.claims =
  '{"sub":"cccccccc-0000-0000-0000-00000000c834","role":"authenticated"}';
select pg_temp.ov('member_b', 'bbbbbbbb-0000-0000-0000-00000000b834');
select pg_temp.ov('member_a', 'aaaaaaaa-0000-0000-0000-00000000a834');
select pg_temp.ov('member_null', null);

-- S, a stranger, naming A's workspace, and with no owner.
set local request.jwt.claims =
  '{"sub":"dddddddd-0000-0000-0000-00000000d834","role":"authenticated"}';
select pg_temp.ov('stranger_a', 'aaaaaaaa-0000-0000-0000-00000000a834');
select pg_temp.ov('stranger_null', null);

reset role;

-- anon, naming A's workspace, and with no owner (00611's refusal).
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select pg_temp.ov('anon_a', 'aaaaaaaa-0000-0000-0000-00000000a834');
select pg_temp.ov('anon_null', null);
reset role;

-- The service role, no sub, naming A's workspace, and with no owner.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.ov('service_role_a', 'aaaaaaaa-0000-0000-0000-00000000a834');
select pg_temp.ov('service_role_null', null);
reset role;

rollback;
