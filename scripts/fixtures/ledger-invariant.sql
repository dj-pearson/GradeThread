-- US-2984 AC4 -- the ledger invariant, as a fixture anyone can re-run.
--
-- Run it with: node scripts/check-ledger-invariant.mjs
--
-- Everything happens inside one transaction that ROLLS BACK, so it can be run
-- against any database with the migrations applied without leaving a row
-- behind. It seeds the six cases that matter and then asks
-- public.ledger_reconciliation() whether the ledger and finances_dashboard
-- agree to the cent.
--
-- THE SIXTH CASE EXISTS BECAUSE A SABOTAGE RUN PASSED WITHOUT IT. Sale 1
-- originally had no shipments row, so removing the double-count guard from the
-- legacy-shipment join changed nothing and the invariant stayed green against
-- a ledger that was genuinely broken. A fixture that cannot exercise a guard
-- cannot verify it.

begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'ledger@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- Item 1: an ordinary sale with every money column populated.
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'Carhartt Detroit Jacket', 42.00, now() - interval '90 days', 'sold')
on conflict (id) do nothing;

-- US-2987: the sales carry an eBay LISTING now, and that is load-bearing rather
-- than decorative. The tax branch is chosen from the platform, and a sale with
-- no listing takes the conservative seller-collected branch -- which would move
-- this fixture's tax out of the excluded account and into gross receipts, and
-- silently stop it exercising the facilitator path it was written for.
-- Each listing goes in AFTER its own item. listings.user_id is NOT NULL and is
-- filled by the set_tenant_from_inventory_item trigger, so a listing inserted
-- before its item cannot resolve a tenant and the insert fails.
insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values ('11111111-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
        'ebay', 195.00, now() - interval '60 days')
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees,
   payment_processing_fees,
   shipping_collected, shipping_cost, grading_cost, other_costs, tax, sale_date, status)
values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
        180.00, 23.40, 5.22, 12.99, 9.85, 3.00, 1.15, 14.87,
        now() - interval '10 days', 'completed')
on conflict (id) do nothing;

-- Item 2: no cost basis at all (the case that overstates profit), no shipping
-- on the sale row, and a legacy shipments row that must therefore count.
insert into public.inventory_items (id, user_id, title, acquired_price, status)
values ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
        'Unknown-cost tee', null, 'sold')
on conflict (id) do nothing;

insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values ('11111111-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002',
        'ebay', 34.99, now() - interval '30 days')
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees,
   payment_processing_fees,
   shipping_collected, shipping_cost, grading_cost, other_costs, tax, sale_date, status)
values ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000002',
        29.99, 3.90, 0.87, 0, 0, 0, 0, 2.47,
        now() - interval '5 days', 'completed')
on conflict (id) do nothing;

insert into public.shipments (id, sale_id, carrier, shipping_cost, label_cost)
values ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002',
        'USPS', 5.60, 0.35)
on conflict (id) do nothing;

-- Sale 1 ALSO has a legacy shipments row, and its sale row already carries a
-- shipping_cost. This is the case the double-count guard exists for, and the
-- fixture did not have it until a sabotage run passed against a broken guard.
insert into public.shipments (id, sale_id, carrier, shipping_cost, label_cost)
values ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
        'UPS', 8.20, 1.65)
on conflict (id) do nothing;

-- Item 3: a CANCELLED sale. Must appear in neither total.
insert into public.inventory_items (id, user_id, title, acquired_price, status)
values ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
        'Cancelled order', 15.00, 'listed')
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, sale_price, platform_fees, sale_date, status)
values ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000003', 500.00, 65.00,
        now() - interval '3 days', 'cancelled')
on conflict (id) do nothing;

-- Overhead: one ordinary expense and one on 'other'.
insert into public.flipdesk_expenses (id, user_id, category, description, amount, spent_on)
values ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'shipping_supplies', 'Poly mailers', 24.99, current_date - 7),
       ('eeeeeeee-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
        'other', 'Something unsorted', 11.00, current_date - 6)
on conflict (id) do nothing;

-- A payout. Must be recorded and must NOT move net.
insert into public.ebay_payouts (id, user_id, payout_id, amount_cents, currency, payout_date)
values ('ffffffff-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'PAYOUT-1', 15234, 'USD', now() - interval '2 days')
on conflict (id) do nothing;

select public.rebuild_ledger_for_user('aaaaaaaa-0000-0000-0000-000000000001') as entries_written;

-- Re-run it. Byte-identical, no duplicates.
select public.rebuild_ledger_for_user('aaaaaaaa-0000-0000-0000-000000000001') as entries_after_rerun;

select a.code, e.source_kind, e.source_detail, e.amount_cents, e.memo
  from public.ledger_entries e join public.ledger_accounts a on a.id = e.account_id
 where e.user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
 order by a.sort_order, e.source_detail;

-- The invariant, as the seller (RLS scopes finances_dashboard, which is
-- security invoker).
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
select jsonb_pretty(public.ledger_reconciliation(null)) as reconciliation;

rollback;
