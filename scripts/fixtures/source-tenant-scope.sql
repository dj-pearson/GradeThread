-- 00824: prove get_or_create_source only writes to an account the caller may
-- write to.
--
-- The function is SECURITY DEFINER, so RLS on public.sources does not apply
-- inside it. Before 00824 its only guard was "signed in", and it trusted
-- p_user_id from the caller: B could plant a source in A's account and probe
-- A's source names.
--
-- IT PROVES BOTH DIRECTIONS. A check that refused everyone would pass the
-- foreign cases on its own and break intake for every seller. So the owner, a
-- listing_manager member and the service role must all still get through.
--
-- Everything runs inside a transaction that ROLLS BACK. It writes nothing.
begin;

-- A owns a workspace with one source. M is A's listing_manager, V is A's
-- viewer, B is a stranger.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a824', 'a824@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b824', 'b824@example.com'),
  ('cccccccc-0000-0000-0000-00000000c824', 'm824@example.com'),
  ('dddddddd-0000-0000-0000-00000000d824', 'v824@example.com')
  on conflict (id) do nothing;
insert into public.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a824', 'a824@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b824', 'b824@example.com'),
  ('cccccccc-0000-0000-0000-00000000c824', 'm824@example.com'),
  ('dddddddd-0000-0000-0000-00000000d824', 'v824@example.com')
  on conflict (id) do nothing;
insert into public.workspace_members (owner_id, member_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a824', 'cccccccc-0000-0000-0000-00000000c824', 'listing_manager'),
  ('aaaaaaaa-0000-0000-0000-00000000a824', 'dddddddd-0000-0000-0000-00000000d824', 'viewer')
  on conflict do nothing;
insert into public.sources (id, user_id, name, source_type) values
  ('5ce00000-0000-0000-0000-000000000824', 'aaaaaaaa-0000-0000-0000-00000000a824',
   'Secret Estate Sale', 'other');

-- What a signed-in caller has. Deliberately NARROW: the function is a
-- definer, so no table grant is needed, and a blanket GRANT ALL is what
-- US-3350 measured destroying every REVOKE in the schema.
grant usage on schema public, auth to anon, authenticated;
grant execute on function public.get_or_create_source(uuid, text, public.flipdesk_source_type)
  to anon, authenticated;

-- One probe per caller. Prints ALLOWED, or REFUSED plus the SQLSTATE.
create function pg_temp.probe(p_label text, p_owner uuid, p_name text)
returns void language plpgsql as $$
begin
  perform public.get_or_create_source(p_owner, p_name);
  raise notice 'RESULT %=ALLOWED', p_label;
exception when others then
  raise notice 'RESULT %=REFUSED_%', p_label, sqlstate;
end $$;
grant execute on function pg_temp.probe(text, uuid, text) to anon, authenticated;

set local role authenticated;

-- THE HOLE, twice. B writes a new source into A's account...
set local request.jwt.claims =
  '{"sub":"bbbbbbbb-0000-0000-0000-00000000b824","role":"authenticated"}';
select pg_temp.probe('foreign_create', 'aaaaaaaa-0000-0000-0000-00000000a824', 'Planted by B');
-- ...and asks for one of A's source names, which used to return A's row id.
select pg_temp.probe('foreign_probe', 'aaaaaaaa-0000-0000-0000-00000000a824', 'secret estate sale');
-- B's own account still works.
select pg_temp.probe('own', 'bbbbbbbb-0000-0000-0000-00000000b824', 'My Goodwill');

-- A's listing_manager can add to A's sources (the 00042 INSERT policy admits
-- the same role).
set local request.jwt.claims =
  '{"sub":"cccccccc-0000-0000-0000-00000000c824","role":"authenticated"}';
select pg_temp.probe('member', 'aaaaaaaa-0000-0000-0000-00000000a824', 'Found by M');

-- A's viewer cannot: the policy needs listing_manager, and so does this.
set local request.jwt.claims =
  '{"sub":"dddddddd-0000-0000-0000-00000000d824","role":"authenticated"}';
select pg_temp.probe('viewer', 'aaaaaaaa-0000-0000-0000-00000000a824', 'Viewer try');

-- A itself, the ordinary intake path.
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000a824","role":"authenticated"}';
select pg_temp.probe('owner', 'aaaaaaaa-0000-0000-0000-00000000a824', 'secret estate sale');

reset role;

-- The edge's shape: service role, no sub.
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.probe('service_role', 'aaaaaaaa-0000-0000-0000-00000000a824', 'From the edge');

-- Nothing B asked for landed in A's account.
reset request.jwt.claims;
do $$
begin
  raise notice 'RESULT planted_rows=%', (
    select count(*) from public.sources
     where user_id = 'aaaaaaaa-0000-0000-0000-00000000a824'
       and name = 'Planted by B');
end $$;

rollback;
