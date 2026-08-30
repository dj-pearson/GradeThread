-- US-2988 -- the 1099-K bridge, exercised against real Postgres.
--
-- Run it with: node scripts/check-1099k-bridge.mjs
--
-- Inside one transaction that ROLLS BACK. Five things the bridge has to get
-- right, and the first two are the ones that would otherwise ship broken:
--
--   1. COMPUTED GROSS IS THE SAME ON BOTH TAX BRANCHES. A 1099-K counts the
--      buyer's payment, so it includes sales tax whether the marketplace
--      collected it (excluded account) or the seller did (inside sales_revenue).
--      An identical eBay sale and Shopify sale must produce an identical gross.
--      Get this wrong and every marketplace seller's variance equals exactly
--      their sales tax -- which looks like a real finding and is not.
--
--   2. THE YEAR IS A CALENDAR YEAR. A December sale and a January sale fall in
--      different forms no matter what the seller's fiscal year is. The fixture
--      puts one sale on 2026-12-28 and one on 2027-01-03.
--
--   3. A cancelled sale is in neither the gross nor the count.
--   4. The variance is reported_gross - computed_gross, and it fires.
--   5. Another platform's sales stay out of this platform's bridge.
begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-000010990000', 'k1099@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- Four items. Same money on the first two; only the platform differs.
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values
 ('b0000000-0000-0000-0000-000010990001', 'a0000000-0000-0000-0000-000010990000',
  'eBay sale', 30.00, '2026-06-01', 'sold'),
 ('b0000000-0000-0000-0000-000010990002', 'a0000000-0000-0000-0000-000010990000',
  'Shopify sale', 30.00, '2026-06-01', 'sold'),
 ('b0000000-0000-0000-0000-000010990003', 'a0000000-0000-0000-0000-000010990000',
  'January next year', 30.00, '2026-06-01', 'sold'),
 ('b0000000-0000-0000-0000-000010990004', 'a0000000-0000-0000-0000-000010990000',
  'Cancelled', 30.00, '2026-06-01', 'listed')
on conflict (id) do nothing;

-- Listings go in AFTER their items: listings.user_id is NOT NULL and filled by
-- the set_tenant_from_inventory_item trigger, so a listing without its item
-- cannot resolve a tenant.
insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values
 ('d0000000-0000-0000-0000-000010990001', 'b0000000-0000-0000-0000-000010990001',
  'ebay', 100.00, '2026-06-10'),
 ('d0000000-0000-0000-0000-000010990002', 'b0000000-0000-0000-0000-000010990002',
  'shopify', 100.00, '2026-06-10'),
 ('d0000000-0000-0000-0000-000010990003', 'b0000000-0000-0000-0000-000010990003',
  'ebay', 100.00, '2026-12-01'),
 ('d0000000-0000-0000-0000-000010990004', 'b0000000-0000-0000-0000-000010990004',
  'ebay', 100.00, '2026-12-01')
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees,
   payment_processing_fees, shipping_collected, shipping_cost, tax,
   sale_date, status)
values
 -- eBay, in year. Buyer paid 100 + 9.99 shipping + 8.25 tax = 118.24
 ('c0000000-0000-0000-0000-000010990001', 'a0000000-0000-0000-0000-000010990000',
  'b0000000-0000-0000-0000-000010990001', 'd0000000-0000-0000-0000-000010990001',
  100.00, 13.00, 2.90, 9.99, 7.50, 8.25, '2026-12-28', 'completed'),
 -- Shopify, identical money. Buyer paid the same 118.24.
 ('c0000000-0000-0000-0000-000010990002', 'a0000000-0000-0000-0000-000010990000',
  'b0000000-0000-0000-0000-000010990002', 'd0000000-0000-0000-0000-000010990002',
  100.00, 13.00, 2.90, 9.99, 7.50, 8.25, '2026-12-28', 'completed'),
 -- eBay, but in the NEXT calendar year. Must not appear in 2026.
 ('c0000000-0000-0000-0000-000010990003', 'a0000000-0000-0000-0000-000010990000',
  'b0000000-0000-0000-0000-000010990003', 'd0000000-0000-0000-0000-000010990003',
  500.00, 65.00, 14.50, 0, 0, 41.25, '2027-01-03', 'completed'),
 -- eBay, cancelled. In neither the gross nor the count.
 ('c0000000-0000-0000-0000-000010990004', 'a0000000-0000-0000-0000-000010990000',
  'b0000000-0000-0000-0000-000010990004', 'd0000000-0000-0000-0000-000010990004',
  900.00, 117.00, 26.10, 0, 0, 74.25, '2026-11-01', 'cancelled')
on conflict (id) do nothing;

select public.rebuild_ledger_for_user('a0000000-0000-0000-0000-000010990000');

-- The form eBay actually sent. Deliberately $50.00 MORE than the app can
-- account for, so the variance is a real number rather than a lucky zero.
insert into public.form_1099k
  (user_id, platform, tax_year, gross_cents, payer_name, payer_tin_last4,
   transaction_count, received_on)
values ('a0000000-0000-0000-0000-000010990000', 'ebay', 2026, 12324,
        'eBay Commerce Inc.', '4821', 2, '2027-01-31')
on conflict (user_id, platform, tax_year) do update
  set gross_cents = excluded.gross_cents;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-000010990000","role":"authenticated"}';

select jsonb_pretty(public.form_1099k_bridge('ebay', 2026))    as ebay_2026;
select jsonb_pretty(public.form_1099k_bridge('shopify', 2026)) as shopify_2026;
select jsonb_pretty(public.form_1099k_bridge('ebay', 2027))    as ebay_2027;
select platform::text, sale_count from public.platforms_with_sales(2026) order by 1;

rollback;
