-- US-3318 / migration 00806: prove the whole-dollar repair on real rows.
--
-- WHY A FIXTURE. 00806 is the one held migration that REWRITES SELLER DATA.
-- Every other held file adds a column, a policy or a table; this one changes
-- prices that profit, payout reconciliation and the revise path all read. Its
-- header states six worked examples and a "the column and the blob move
-- together" guarantee, and until this ran, both were arguments rather than
-- measurements.
--
-- THE SHAPE MATTERS AND IT IS EASY TO GET WRONG. platform_fields is keyed by
-- PLATFORM: {"poshmark": {"price": 32.49}}, not {"price": 32.49}. A first
-- version of this fixture seeded the flat shape, the blob half matched nothing,
-- and it read exactly like the half repair the migration's header warns about.
-- The migration was right and the fixture was wrong.
--
-- Runs inside a transaction that ROLLS BACK. It writes nothing.
begin;

insert into auth.users (id, email)
  values ('cccccccc-0000-0000-0000-000000000003', 'price-probe@example.com')
  on conflict (id) do nothing;
insert into public.users (id, email)
  values ('cccccccc-0000-0000-0000-000000000003', 'price-probe@example.com')
  on conflict (id) do nothing;
insert into public.inventory_items (id, user_id, title)
  values ('33333333-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-000000000003', 'Price probe jacket');

-- The six worked examples from 00806's header, plus three rows that must NOT
-- move: eBay and Depop are not whole-dollar marketplaces, and a zero price is
-- "no price set" rather than a rounding error.
insert into public.listings
  (id, inventory_item_id, user_id, platform, listing_price, platform_fields)
values
  ('44444444-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', 'poshmark', 32.49,
   '{"poshmark":{"price":32.49}}'),
  ('44444444-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', 'poshmark', 32.50,
   '{"poshmark":{"price":32.50}}'),
  ('44444444-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', 'vinted', 31.50,
   '{"vinted":{"price":31.50,"price_override":31.50}}'),
  ('44444444-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', 'vinted', 0.40,
   '{"vinted":{"price":0.40}}'),
  -- `title` is here to prove the merge keeps the rest of the channel's entry.
  ('44444444-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', 'poshmark', 0.01,
   '{"poshmark":{"price":0.01,"title":"keep me"}}'),
  ('44444444-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', 'poshmark', 25.00,
   '{"poshmark":{"price":25.00}}'),
  ('44444444-0000-0000-0000-000000000007', '33333333-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', 'ebay', 32.49,
   '{"ebay":{"price":32.49}}'),
  ('44444444-0000-0000-0000-000000000008', '33333333-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', 'depop', 32.49,
   '{"depop":{"price":32.49}}'),
  ('44444444-0000-0000-0000-000000000009', '33333333-0000-0000-0000-000000000001',
   'cccccccc-0000-0000-0000-000000000003', 'poshmark', 0.00,
   '{"poshmark":{"price":0}}');

-- The runner splices the real migration in here. See runFixture's `includes`
-- for why this is a placeholder rather than \ir.
-- @@MIGRATION_00806@@

-- One JSON object, so a runner can assert on it without parsing a table.
select json_build_object(
  'rows', (
    select json_agg(json_build_object(
      'platform', platform,
      'price', listing_price::text,
      'blob', platform_fields -> platform::text ->> 'price',
      'override', platform_fields -> platform::text ->> 'price_override',
      'other_key', platform_fields -> platform::text ->> 'title'
    ) order by id)
      from public.listings
     where inventory_item_id = '33333333-0000-0000-0000-000000000001'
  )
) as result;

rollback;
