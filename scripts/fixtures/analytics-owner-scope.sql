-- 00836: prove the FlipDesk Analytics RPCs read ONE workspace, refuse a caller
-- who is not in it, and leave the community cohort exactly as it was.
--
-- The invoker RPCs read items_full / listings, whose SELECT policies admit the
-- caller's own rows OR any workspace they belong to, so before 00836 a seller
-- in two workspaces got both blended. The definer RPCs (seller_scorecard,
-- community_benchmarks) built their "you" figures from auth.uid(), so a member
-- inside an owner's workspace saw their own figures instead of the owner's.
--
-- The shape: A owns six items AND is a member of B's workspace. B owns five.
-- M is a member of both. S is a stranger. P1..P5 are other sellers, there so
-- the cohort clears its k-anonymity floor of 5 and has numbers to compare.
-- A and B give different numbers on every RPC, so a blend shows.
--
-- IT PROVES BOTH DIRECTIONS. A function that refused everyone would pass the
-- stranger case on its own, so the owner, members and the service role must
-- all still get their numbers.
--
-- Everything runs inside a transaction that ROLLS BACK. It writes nothing.
begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a836', 'a836@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b836', 'b836@example.com'),
  ('cccccccc-0000-0000-0000-00000000c836', 'm836@example.com'),
  ('dddddddd-0000-0000-0000-00000000d836', 's836@example.com'),
  ('eeeeeeee-0000-0000-0000-0000000e1836', 'p1-836@example.com'),
  ('eeeeeeee-0000-0000-0000-0000000e2836', 'p2-836@example.com'),
  ('eeeeeeee-0000-0000-0000-0000000e3836', 'p3-836@example.com'),
  ('eeeeeeee-0000-0000-0000-0000000e4836', 'p4-836@example.com'),
  ('eeeeeeee-0000-0000-0000-0000000e5836', 'p5-836@example.com')
  on conflict (id) do nothing;
insert into public.users (id, email)
  select id, email from auth.users where email like '%836@example.com'
  on conflict (id) do nothing;

-- A is in B's workspace; M is in both.
insert into public.workspace_members (owner_id, member_id, role) values
  ('bbbbbbbb-0000-0000-0000-00000000b836', 'aaaaaaaa-0000-0000-0000-00000000a836', 'viewer'),
  ('aaaaaaaa-0000-0000-0000-00000000a836', 'cccccccc-0000-0000-0000-00000000c836', 'viewer'),
  ('bbbbbbbb-0000-0000-0000-00000000b836', 'cccccccc-0000-0000-0000-00000000c836', 'listing_manager')
  on conflict do nothing;

-- A: six items, all listed 30 days ago. a1-a3 sold (completed), a4 refunded,
-- a5 and a6 still active on eBay. a1, a2 and a5 are graded.
-- B: five items, all listed. b1 sold (completed, graded), b2-b5 active.
insert into public.inventory_items (id, user_id, title, brand, status, grade_value) values
  ('a1000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836', 'A one',   'Alpha', 'sold',     9.0),
  ('a2000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836', 'A two',   'Alpha', 'sold',     5.0),
  ('a3000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836', 'A three', 'Alpha', 'sold',     null),
  ('a4000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836', 'A four',  'Alpha', 'returned', null),
  ('a5000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836', 'A five',  'Alpha', 'listed',   8.0),
  ('a6000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836', 'A six',   'Alpha', 'listed',   null),
  ('b1000000-0000-0000-0000-000000000836', 'bbbbbbbb-0000-0000-0000-00000000b836', 'B one',   'Beta',  'sold',     9.5),
  ('b2000000-0000-0000-0000-000000000836', 'bbbbbbbb-0000-0000-0000-00000000b836', 'B two',   'Beta',  'listed',   null),
  ('b3000000-0000-0000-0000-000000000836', 'bbbbbbbb-0000-0000-0000-00000000b836', 'B three', 'Beta',  'listed',   null),
  ('b4000000-0000-0000-0000-000000000836', 'bbbbbbbb-0000-0000-0000-00000000b836', 'B four',  'Beta',  'listed',   null),
  ('b5000000-0000-0000-0000-000000000836', 'bbbbbbbb-0000-0000-0000-00000000b836', 'B five',  'Beta',  'listed',   null);

-- P1..P5: five items each, all listed, the first two sold.
insert into public.inventory_items (user_id, title, brand, status)
  select u.id, 'P item ' || n, 'Gamma', case when n <= 2 then 'sold' else 'listed' end::public.item_status
  from auth.users u cross join generate_series(1, 5) n
  where u.email like 'p_-836@example.com';

insert into public.listings (inventory_item_id, user_id, platform, listing_price, listed_at, listing_status, views_total)
  select i.id, i.user_id, 'ebay', 100,
    now() - interval '30 days',
    (case when i.status in ('sold', 'returned') then 'sold' else 'active' end)::public.listing_status,
    case i.id
      when 'a5000000-0000-0000-0000-000000000836' then 30
      when 'a6000000-0000-0000-0000-000000000836' then 0
      else 100
    end
  from public.inventory_items i
  join auth.users u on u.id = i.user_id
  where u.email like '%836@example.com';

insert into public.sales (inventory_item_id, user_id, sale_price, net_profit, status, sold_at) values
  ('a1000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836',  40,  10, 'completed', now() - interval '10 days'),
  ('a2000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836',  60,  20, 'completed', now() - interval '10 days'),
  ('a3000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836', 200, 100, 'completed', now() - interval '10 days'),
  ('a4000000-0000-0000-0000-000000000836', 'aaaaaaaa-0000-0000-0000-00000000a836',  30,   0, 'refunded',  now() - interval '10 days'),
  ('b1000000-0000-0000-0000-000000000836', 'bbbbbbbb-0000-0000-0000-00000000b836',  50,  15, 'completed', now() - interval '10 days');
insert into public.sales (inventory_item_id, user_id, sale_price, net_profit, status, sold_at)
  select i.id, i.user_id, 25, 5, 'completed', now() - interval '10 days'
  from public.inventory_items i
  join auth.users u on u.id = i.user_id
  where u.email like 'p_-836@example.com' and i.status = 'sold';

-- What a signed-in caller has. Local only and rolled back with everything
-- else: items_full is security_invoker, so the caller needs SELECT on the
-- tables under it. Never read grant state off a stack after this.
grant usage on schema public, auth to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated, service_role;

-- One probe per RPC per call. Each prints RESULT <rpc>.<label>=<shape>, or
-- REFUSED_<sqlstate>. The shapes are chosen so A, B and A+B all differ.
create function pg_temp.probe(p_label text, p_owner uuid)
returns void language plpgsql as $$
declare
  r jsonb;
  v1 jsonb;
  s text;
begin
  -- sell-through by category: rows summed.
  begin
    r := public.flipdesk_sell_through('category', null, p_owner);
    raise notice 'RESULT st.%=listed:%,sold:%', p_label,
      coalesce((select sum((e ->> 'listed')::int) from jsonb_array_elements(r) e), 0),
      coalesce((select sum((e ->> 'sold')::int) from jsonb_array_elements(r) e), 0);
  exception when others then
    raise notice 'RESULT st.%=REFUSED_%', p_label, sqlstate;
  end;

  -- grading ROI headline: listed/sold on each side.
  begin
    r := public.flipdesk_grading_roi_summary(null, p_owner);
    raise notice 'RESULT roisum.%=g:%/%,u:%/%', p_label,
      r #>> '{graded,listed}', r #>> '{graded,sold}',
      r #>> '{ungraded,listed}', r #>> '{ungraded,sold}';
  exception when others then
    raise notice 'RESULT roisum.%=REFUSED_%', p_label, sqlstate;
  end;

  -- grading ROI buckets: sold items across every bucket.
  begin
    r := public.flipdesk_grading_roi(null, p_owner);
    raise notice 'RESULT roi.%=sold:%', p_label,
      coalesce((select sum((e #>> '{graded,count}')::int + (e #>> '{ungraded,count}')::int)
                  from jsonb_array_elements(r) e), 0);
  exception when others then
    raise notice 'RESULT roi.%=REFUSED_%', p_label, sqlstate;
  end;

  -- returns: fulfilled and refunded, overall.
  begin
    r := public.flipdesk_return_reduction_v2(null, p_owner);
    raise notice 'RESULT ret.%=sold:%,returns:%', p_label,
      r #>> '{overall,sold}', r #>> '{overall,returns}';
  exception when others then
    raise notice 'RESULT ret.%=REFUSED_%', p_label, sqlstate;
  end;

  -- listing performance tiles.
  begin
    select format('n:%s,views:%s', total_listings, total_views) into s
      from public.flipdesk_listing_performance_summary(p_owner);
    raise notice 'RESULT lps.%=%', p_label, s;
  exception when others then
    raise notice 'RESULT lps.%=REFUSED_%', p_label, sqlstate;
  end;

  -- listing performance page: the count riding on each row, and the rows.
  begin
    select format('total:%s,rows:%s', coalesce(max(total_count), 0), count(*)) into s
      from public.flipdesk_listing_performance_page(null, 0, 'views_total', true, 50, 0, p_owner);
    raise notice 'RESULT lpp.%=%', p_label, s;
  exception when others then
    raise notice 'RESULT lpp.%=REFUSED_%', p_label, sqlstate;
  end;

  -- seller scorecard: the own figures, and a hash of the cohort alone.
  begin
    r := public.seller_scorecard(null, p_owner);
    raise notice 'RESULT sc.%=own:%,n:%,fulfilled:%,returns:%', p_label,
      coalesce((select e ->> 'ownValue' from jsonb_array_elements(r -> 'metrics') e
                 where e ->> 'metric' = 'sell_through'), 'null'),
      (select e ->> 'ownSampleSize' from jsonb_array_elements(r -> 'metrics') e
        where e ->> 'metric' = 'sell_through'),
      (r #>> '{returnSplit,ungraded,fulfilled}')::int + (r #>> '{returnSplit,graded,fulfilled}')::int,
      (r #>> '{returnSplit,ungraded,returns}')::int + (r #>> '{returnSplit,graded,returns}')::int;
    raise notice 'COHORT sc.%=%', p_label, left(md5((
      select jsonb_agg(e - 'ownValue' - 'ownSampleSize' - 'ownPercentile' order by e ->> 'metric')
      from jsonb_array_elements(r -> 'metrics') e
    )::text || (r - 'metrics' - 'returnSplit')::text), 12);
  exception when others then
    raise notice 'RESULT sc.%=REFUSED_%', p_label, sqlstate;
  end;

  -- community benchmarks v2: the you block, and whether everything outside it
  -- is byte-identical to v1 (00640) for the same caller.
  begin
    r := public.community_benchmarks_v2(null, null, null, null, null, null, p_owner);
    v1 := public.community_benchmarks(null, null, null, null, null, null);
    raise notice 'RESULT cb.%=listed:%,sold:%,peers:%,cohort:%', p_label,
      r #>> '{you,listed}', r #>> '{you,sold}',
      coalesce(r #>> '{you,peerComparison,peerCount}', 'none'),
      case when (r - 'you') = (v1 - 'you') then 'same' else 'DIFF' end;
    -- generatedAt is now(), so it is left out of the hash that runs compare.
    raise notice 'COHORT cb.%=%', p_label,
      left(md5(((r - 'you') #- '{meta,generatedAt}')::text), 12);
  exception when others then
    raise notice 'RESULT cb.%=REFUSED_%', p_label, sqlstate;
  end;
end $$;
grant execute on function pg_temp.probe(text, uuid) to anon, authenticated, service_role;

set local role authenticated;

-- A, in A's own workspace, with no owner (an old client), and inside B's.
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000a836","role":"authenticated"}';
select pg_temp.probe('owner_a', 'aaaaaaaa-0000-0000-0000-00000000a836');
select pg_temp.probe('owner_a_null', null);
select pg_temp.probe('a_in_b', 'bbbbbbbb-0000-0000-0000-00000000b836');

-- M, a member of both, in each; and with no owner, M's own (empty) account.
set local request.jwt.claims =
  '{"sub":"cccccccc-0000-0000-0000-00000000c836","role":"authenticated"}';
select pg_temp.probe('member_b', 'bbbbbbbb-0000-0000-0000-00000000b836');
select pg_temp.probe('member_a', 'aaaaaaaa-0000-0000-0000-00000000a836');
select pg_temp.probe('member_null', null);

-- S, a stranger, naming A's workspace, and with no owner.
set local request.jwt.claims =
  '{"sub":"dddddddd-0000-0000-0000-00000000d836","role":"authenticated"}';
select pg_temp.probe('stranger_a', 'aaaaaaaa-0000-0000-0000-00000000a836');
select pg_temp.probe('stranger_null', null);

reset role;

-- anon, naming A's workspace, and with no owner.
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select pg_temp.probe('anon_a', 'aaaaaaaa-0000-0000-0000-00000000a836');
select pg_temp.probe('anon_null', null);
reset role;

-- The service role, no sub, naming A's workspace, and with no owner.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.probe('service_role_a', 'aaaaaaaa-0000-0000-0000-00000000a836');
select pg_temp.probe('service_role_null', null);
reset role;

rollback;
