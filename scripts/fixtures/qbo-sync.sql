-- US-2998 -- what is due to push to QuickBooks, against real Postgres.
--
-- Run it with: node scripts/check-qbo-sync.mjs
--
-- Inside one transaction that ROLLS BACK. It seeds a seller with one sale (with
-- fees, a label, facilitator tax and a cost basis), one operating expense and
-- one payout, then checks the four things qbo_pending_documents has to get
-- right before a single document reaches Intuit:
--
--   1. GROUPING. A sale's revenue, shipping, fees, label and cost of goods are
--      ONE document, not five. Five would put the same sale into QuickBooks as
--      five unrelated receipts.
--   2. THE TAX SPLIT. Facilitator sales tax is out of the total and reported
--      beside it. In the total it would overstate income by money the seller
--      never had; absent entirely it would leave an accountant unable to
--      reconcile against the 1099-K.
--   3. THE PAYOUT LINK. sales.payout_reference -> ebay_payouts.payout_id is a
--      real join. Matching a deposit to sales by AMOUNT is how a reconciliation
--      goes wrong the first time two payouts are the same size.
--   4. THE TENANT GUARD. A signed-in caller asking for someone else's id is
--      refused with 42501, not answered.
begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-00000000ab00', 'qbo@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-00000000ab99', 'other@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- The sold item, with a cost basis so cost of goods lands on the SALE.
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values ('b0000000-0000-0000-0000-0000000ab001', 'a0000000-0000-0000-0000-00000000ab00',
        'A jacket', 42.00, '2025-02-01', 'sold')
on conflict (id) do nothing;

insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values ('d0000000-0000-0000-0000-0000000ab001', 'b0000000-0000-0000-0000-0000000ab001',
        'ebay', 180.00, '2025-02-10')
on conflict (id) do nothing;

-- One sale carrying every component: price, shipping collected, facilitator
-- tax, fees, a label and grading. All five non-tax parts must land in ONE
-- document.
insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, shipping_collected,
   tax, platform_fees, payment_processing_fees, shipping_cost, grading_cost,
   sale_date, status, payout_reference)
values ('c0000000-0000-0000-0000-0000000ab001', 'a0000000-0000-0000-0000-00000000ab00',
        'b0000000-0000-0000-0000-0000000ab001', 'd0000000-0000-0000-0000-0000000ab001',
        180.00, 12.99, 14.87, 23.40, 5.22, 9.85, 3.00,
        '2025-03-01', 'completed', 'PAYOUT-QB-1')
on conflict (id) do nothing;

-- An operating expense: its own document.
insert into public.flipdesk_expenses (id, user_id, category, description, amount, spent_on)
values ('e0000000-0000-0000-0000-0000000ab001', 'a0000000-0000-0000-0000-00000000ab00',
        'shipping_supplies', 'Big supply order', 120.00, '2025-06-02')
on conflict (id) do nothing;

-- A payout the sale above belongs to.
insert into public.ebay_payouts (id, user_id, payout_id, amount_cents, currency, payout_date)
values ('f0000000-0000-0000-0000-0000000ab001', 'a0000000-0000-0000-0000-00000000ab00',
        'PAYOUT-QB-1', 15138, 'USD', '2025-03-05')
on conflict (id) do nothing;

-- A sale belonging to a DIFFERENT seller, on the same payout reference. It must
-- never appear in this seller's answers.
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values ('b0000000-0000-0000-0000-0000000ab099', 'a0000000-0000-0000-0000-00000000ab99',
        'Not yours', 10.00, '2025-02-01', 'sold')
on conflict (id) do nothing;
insert into public.sales
  (id, user_id, inventory_item_id, sale_price, sale_date, status, payout_reference)
values ('c0000000-0000-0000-0000-0000000ab099', 'a0000000-0000-0000-0000-00000000ab99',
        'b0000000-0000-0000-0000-0000000ab099', 99.00, '2025-03-01', 'completed', 'PAYOUT-QB-1')
on conflict (id) do nothing;

select public.rebuild_ledger_for_user('a0000000-0000-0000-0000-00000000ab00') as rebuilt;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000ab00","role":"authenticated"}';

select jsonb_pretty(coalesce(jsonb_agg(to_jsonb(d) order by d.doc_date, d.object_kind), '[]'::jsonb)) as documents
  from public.qbo_pending_documents(
    'a0000000-0000-0000-0000-00000000ab00', '2025-01-01', '2026-01-01') d;

select 'payout sales' as q,
       count(*)::text as a
  from public.qbo_payout_sales(
    'a0000000-0000-0000-0000-00000000ab00', 'f0000000-0000-0000-0000-0000000ab001');

select 'payout sale id' as q,
       coalesce((select sale_id::text from public.qbo_payout_sales(
         'a0000000-0000-0000-0000-00000000ab00',
         'f0000000-0000-0000-0000-0000000ab001')), 'none') as a;

-- AC7's cursor: asking for documents on or after 2025-06-01 must skip the
-- March sale and keep the June expense.
select 'after cursor' as q,
       count(*)::text as a
  from public.qbo_pending_documents(
    'a0000000-0000-0000-0000-00000000ab00', '2025-01-01', '2026-01-01', '2025-06-01') d;

-- The bound is a bound.
select 'limit respected' as q,
       count(*)::text as a
  from public.qbo_pending_documents(
    'a0000000-0000-0000-0000-00000000ab00', '2025-01-01', '2026-01-01', null, 1) d;

-- THE TENANT GUARD. A signed-in caller naming somebody else must be refused.
do $$
begin
  perform * from public.qbo_pending_documents(
    'a0000000-0000-0000-0000-00000000ab99', '2025-01-01', '2026-01-01');
  raise notice 'GUARD|leaked';
exception
  when insufficient_privilege then raise notice 'GUARD|refused';
  when others then raise notice 'GUARD|other:%', sqlstate;
end $$;

do $$
begin
  perform * from public.qbo_payout_sales(
    'a0000000-0000-0000-0000-00000000ab99', 'f0000000-0000-0000-0000-0000000ab001');
  raise notice 'PAYOUT_GUARD|leaked';
exception
  when insufficient_privilege then raise notice 'PAYOUT_GUARD|refused';
  when others then raise notice 'PAYOUT_GUARD|other:%', sqlstate;
end $$;

rollback;
