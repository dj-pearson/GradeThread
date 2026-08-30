-- US-3018 -- public.sale_pnl against public.finances_dashboard, as a fixture
-- anyone can re-run.
--
-- Run it with: node scripts/check-sale-pnl-invariant.mjs
--
-- One transaction that ROLLS BACK, so it leaves nothing behind. Same claim the
-- ledger invariant makes and the same reason for making it: sale_pnl is a THIRD
-- route to the same number, and a third route that disagrees by a cent is a
-- report that quietly contradicts the P&L a seller has been reading for months.
--
-- The cases, and why each is here:
--   1. An ordinary sale with every money column populated, AND a legacy
--      shipments row on a sale that already carries shipping_cost. This is the
--      double-count guard. The ledger fixture learned the hard way that a
--      fixture which cannot exercise a guard cannot verify it.
--   2. No cost basis, no shipping on the sale row, and a legacy shipments row
--      that therefore MUST count. This is the term pnl_net in 00143 omits, and
--      the one a copy-paste of that column would miss.
--   3. A cancelled sale. Must appear in neither total.
--   4. Two items sourced by 'Dan' and 'dan'. They must collapse to ONE sourcer.
--   5. An item with sourced_by NULL. Must land in 'Unassigned', not vanish.
--   6. An item with a real sources row, and one with only acquired_source text.

begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('aaaaaaaa-0000-0000-0000-00000000a001', 'salepnl@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

insert into public.sources (id, user_id, name, source_type)
values ('50000000-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-00000000a001',
        'Eastside Estate Sales', 'other')
on conflict (id) do nothing;

-- Item 1 -- Dan, a real source row, every money column, plus a legacy shipment
-- the guard must IGNORE because the sale row carries its own shipping_cost.
insert into public.inventory_items
  (id, user_id, title, brand, acquired_price, acquired_date, status, sourced_by, source_id)
values ('bbbbbbbb-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-00000000a001',
        'Carhartt Detroit Jacket', 'Carhartt', 42.00, now() - interval '90 days',
        'sold', 'Dan', '50000000-0000-0000-0000-00000000a001')
on conflict (id) do nothing;

insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values ('11111111-0000-0000-0000-00000000a001', 'bbbbbbbb-0000-0000-0000-00000000a001',
        'ebay', 195.00, now() - interval '60 days')
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees,
   payment_processing_fees, shipping_collected, shipping_cost, grading_cost,
   other_costs, tax, sale_date, status)
values ('cccccccc-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-00000000a001',
        'bbbbbbbb-0000-0000-0000-00000000a001', '11111111-0000-0000-0000-00000000a001',
        180.00, 23.40, 5.22, 12.99, 9.85, 3.00, 1.15, 14.87,
        now() - interval '10 days', 'completed')
on conflict (id) do nothing;

insert into public.shipments (id, sale_id, carrier, shipping_cost, label_cost)
values ('dddddddd-0000-0000-0000-00000000a001', 'cccccccc-0000-0000-0000-00000000a001',
        'UPS', 8.20, 1.65)
on conflict (id) do nothing;

-- Item 2 -- 'dan' in lower case, so it MUST collapse onto item 1's sourcer.
-- No cost basis, no shipping on the sale row, and a legacy shipment that
-- therefore MUST be subtracted.
insert into public.inventory_items
  (id, user_id, title, acquired_price, status, sourced_by, acquired_source)
values ('bbbbbbbb-0000-0000-0000-00000000a002', 'aaaaaaaa-0000-0000-0000-00000000a001',
        'Unknown-cost tee', null, 'sold', 'dan', 'Goodwill on Main')
on conflict (id) do nothing;

insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values ('11111111-0000-0000-0000-00000000a002', 'bbbbbbbb-0000-0000-0000-00000000a002',
        'ebay', 34.99, now() - interval '30 days')
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees,
   payment_processing_fees, shipping_collected, shipping_cost, grading_cost,
   other_costs, tax, sale_date, status)
values ('cccccccc-0000-0000-0000-00000000a002', 'aaaaaaaa-0000-0000-0000-00000000a001',
        'bbbbbbbb-0000-0000-0000-00000000a002', '11111111-0000-0000-0000-00000000a002',
        29.99, 3.90, 0.87, 0, 0, 0, 0, 2.47,
        now() - interval '5 days', 'completed')
on conflict (id) do nothing;

insert into public.shipments (id, sale_id, carrier, shipping_cost, label_cost)
values ('dddddddd-0000-0000-0000-00000000a002', 'cccccccc-0000-0000-0000-00000000a002',
        'USPS', 5.60, 0.35)
on conflict (id) do nothing;

-- Item 3 -- sourced_by NULL. Must land in 'Unassigned'.
insert into public.inventory_items
  (id, user_id, title, acquired_price, acquired_date, status, sourced_by)
values ('bbbbbbbb-0000-0000-0000-00000000a003', 'aaaaaaaa-0000-0000-0000-00000000a001',
        'Nobody remembers this one', 8.00, now() - interval '200 days', 'sold', null)
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, sale_price, platform_fees,
   payment_processing_fees, shipping_collected, shipping_cost, grading_cost,
   other_costs, tax, sale_date, status)
values ('cccccccc-0000-0000-0000-00000000a003', 'aaaaaaaa-0000-0000-0000-00000000a001',
        'bbbbbbbb-0000-0000-0000-00000000a003', 61.00, 7.93, 1.77, 0, 6.10, 0, 0, 0,
        now() - interval '2 days', 'completed')
on conflict (id) do nothing;

-- Item 4 -- a CANCELLED sale, sourced by a person who has no other sales.
-- Must appear in neither total and must NOT create a sourcer row.
insert into public.inventory_items
  (id, user_id, title, acquired_price, status, sourced_by)
values ('bbbbbbbb-0000-0000-0000-00000000a004', 'aaaaaaaa-0000-0000-0000-00000000a001',
        'Cancelled order', 15.00, 'listed', 'Ghost')
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, sale_price, platform_fees, sale_date, status)
values ('cccccccc-0000-0000-0000-00000000a004', 'aaaaaaaa-0000-0000-0000-00000000a001',
        'bbbbbbbb-0000-0000-0000-00000000a004', 500.00, 65.00,
        now() - interval '3 days', 'cancelled')
on conflict (id) do nothing;

-- The whole point, read as the seller. finances_dashboard is security invoker
-- and so is sale_pnl, so both must run under the same role for the comparison
-- to mean anything.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-00000000a001","role":"authenticated"}';

with d as (
  select (round(((public.finances_dashboard(null) -> 'summary' ->> 'net_profit')::numeric) * 100))::bigint as cents
), v as (
  select (round(coalesce((select sum(net) from public.sale_pnl), 0) * 100))::bigint as cents
)
select jsonb_pretty(jsonb_build_object(
  'dashboard_net_cents', d.cents,
  'view_net_cents',      v.cents,
  'variance_cents',      v.cents - d.cents,
  'agrees',              v.cents = d.cents,
  'row_count',           (select count(*) from public.sale_pnl),
  'sourcer_count',       (select count(distinct sourcer_key) from public.sale_pnl),
  'dan_rows',            (select count(*) from public.sale_pnl where sourcer_key = 'dan'),
  'unassigned_rows',     (select count(*) from public.sale_pnl where sourcer_key = 'unassigned'),
  'ghost_rows',          (select count(*) from public.sale_pnl where sourcer_key = 'ghost'),
  'source_keys',         (select jsonb_agg(distinct source_key) from public.sale_pnl)
)) as reconciliation
from d, v;

rollback;
