-- US-2986 -- the COGS worksheet, exercised against real Postgres.
--
-- Run it with: node scripts/check-cogs-worksheet.mjs
--
-- Everything happens inside one transaction that ROLLS BACK. It seeds a seller
-- with a two-year history and checks four things the worksheet has to get
-- right:
--
--   1. an item bought in year 1 and still unsold at year end is IN ending
--      inventory, and is therefore year 2's beginning inventory;
--   2. an item bought AND sold in year 1 is in neither snapshot;
--   3. the snapshot survives an edit to acquired_price afterwards, because the
--      cost was copied rather than referenced;
--   4. a sold item with NO cost basis is REPORTED, and does NOT move the
--      variance -- because both routes read the same acquired_price column, so
--      a null cancels on both sides. That is a finding, not a bug: the variance
--      catches STRUCTURAL mismatches and the items_without_cost counts catch
--      UNDERSTATED ones, and the screen has to show both;
--   5. an item whose acquisition date falls outside the period it was sold in
--      DOES move the variance. That is the structural case, and it is here so
--      the check can actually fail.
--
-- The fifth is the point. A worksheet that always reconciles is a worksheet
-- that is not checking anything.
begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-00000000c065', 'cogs@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- Year 1 (2025): three items bought.
--   A  $40  sold in 2025          -> in no snapshot, in 2025 COGS
--   B  $25  still held at year end -> in the 2026-01-01 snapshot
--   C  $60  sold in 2026          -> in the 2026-01-01 snapshot, in 2026 COGS
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values
 ('b0000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-00000000c065',
  'Item A sold same year', 40.00, '2025-03-01', 'sold'),
 ('b0000000-0000-0000-0000-0000000000b2', 'a0000000-0000-0000-0000-00000000c065',
  'Item B still held', 25.00, '2025-06-01', 'listed'),
 ('b0000000-0000-0000-0000-0000000000c3', 'a0000000-0000-0000-0000-00000000c065',
  'Item C sold next year', 60.00, '2025-09-01', 'sold')
on conflict (id) do nothing;

-- Year 2 (2026): one item bought with NO cost basis, and sold. This is the
-- case that breaks the reconciliation on purpose.
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values
 ('b0000000-0000-0000-0000-0000000000d4', 'a0000000-0000-0000-0000-00000000c065',
  'Item D no cost basis', null, '2026-02-01', 'sold')
on conflict (id) do nothing;

-- Item F: acquired 2027 on paper, sold in 2026. A mis-entered acquisition date,
-- which is the commonest way the two routes to COGS come apart -- the ledger
-- books the cost at the SALE, and the worksheet looks for the purchase in a
-- period that does not contain it.
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values
 ('b0000000-0000-0000-0000-0000000000f6', 'a0000000-0000-0000-0000-00000000c065',
  'Item F acquisition date wrong', 50.00, '2027-03-01', 'sold')
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, sale_price, platform_fees, sale_date, status)
values
 ('c0000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-00000000c065',
  'b0000000-0000-0000-0000-0000000000a1', 95.00, 12.00, '2025-05-01', 'completed'),
 ('c0000000-0000-0000-0000-0000000000c3', 'a0000000-0000-0000-0000-00000000c065',
  'b0000000-0000-0000-0000-0000000000c3', 140.00, 18.00, '2026-04-01', 'completed'),
 ('c0000000-0000-0000-0000-0000000000d4', 'a0000000-0000-0000-0000-00000000c065',
  'b0000000-0000-0000-0000-0000000000d4', 70.00, 9.00, '2026-05-01', 'completed'),
 ('c0000000-0000-0000-0000-0000000000f6', 'a0000000-0000-0000-0000-00000000c065',
  'b0000000-0000-0000-0000-0000000000f6', 120.00, 15.00, '2026-08-01', 'completed')
on conflict (id) do nothing;

select public.rebuild_ledger_for_user('a0000000-0000-0000-0000-00000000c065');

-- Snapshots at both year boundaries.
select public.take_inventory_snapshot(
  'a0000000-0000-0000-0000-00000000c065', date '2025-01-01', '2025', true) as snap_2025_start;
select public.take_inventory_snapshot(
  'a0000000-0000-0000-0000-00000000c065', date '2026-01-01', '2026', true) as snap_2026_start;
select public.take_inventory_snapshot(
  'a0000000-0000-0000-0000-00000000c065', date '2027-01-01', '2027', false) as snap_2027_start;

select as_of, item_count, items_without_cost, total_cost_cents, reconstructed
  from public.inventory_snapshots
 where user_id = 'a0000000-0000-0000-0000-00000000c065'
 order by as_of;

-- CHECK 3: edit the cost basis AFTER the snapshot. The snapshot must not move.
update public.inventory_items set acquired_price = 999.00
 where id = 'b0000000-0000-0000-0000-0000000000b2';

select 'after editing item B to $999, the 2026 snapshot total is' as check,
       total_cost_cents
  from public.inventory_snapshots
 where user_id = 'a0000000-0000-0000-0000-00000000c065' and as_of = '2026-01-01';

-- put it back so the ledger figures below are the ones the fixture describes
update public.inventory_items set acquired_price = 25.00
 where id = 'b0000000-0000-0000-0000-0000000000b2';

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000c065","role":"authenticated"}';

select jsonb_pretty(public.cogs_worksheet(date '2025-01-01', date '2026-01-01')) as year_2025;
select jsonb_pretty(public.cogs_worksheet(date '2026-01-01', date '2027-01-01')) as year_2026;
select * from public.items_missing_cost_basis(date '2026-01-01', date '2027-01-01');

rollback;
