-- US-2992 -- the books review queue, against real Postgres.
--
-- Run it with: node scripts/check-books-review.mjs
--
-- Inside one transaction that ROLLS BACK. It seeds one of every issue the queue
-- knows about, plus three things that must NOT be flagged, and checks:
--
--   1. all six kinds fire;
--   2. THE THREE FALSE POSITIVES STAY QUIET -- a local cash sale genuinely has
--      no fees, a $12 expense is under the substantiation threshold, and an
--      item with a real cost basis is fine. A queue that cries wolf is one
--      nobody opens twice;
--   3. the impact is EXACT where it can be and ESTIMATED where it cannot: a
--      sold item with no cost basis is overstated by whatever it cost, which is
--      precisely what nobody recorded, so it carries a ratio-derived estimate;
--   4. dismissing removes it and undismissing brings it back.
begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-0000000bee00', 'review@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- Five priced sales, so median_cost_ratio_bps has enough history to return a
-- ratio. All at 40% cost-to-price, which makes the estimate checkable by hand.
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
select ('b0000000-0000-0000-0000-00000000000' || n)::uuid,
       'a0000000-0000-0000-0000-0000000bee00',
       'Priced item ' || n, 40.00, '2025-02-01', 'sold'
  from generate_series(1,5) n
on conflict (id) do nothing;

insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
select ('d0000000-0000-0000-0000-00000000000' || n)::uuid,
       ('b0000000-0000-0000-0000-00000000000' || n)::uuid,
       'ebay', 100.00, '2025-02-10'
  from generate_series(1,5) n
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees, sale_date, status)
select ('c0000000-0000-0000-0000-00000000000' || n)::uuid,
       'a0000000-0000-0000-0000-0000000bee00',
       ('b0000000-0000-0000-0000-00000000000' || n)::uuid,
       ('d0000000-0000-0000-0000-00000000000' || n)::uuid,
       100.00, 13.00, '2025-03-01', 'completed'
  from generate_series(1,5) n
on conflict (id) do nothing;

-- ISSUE 1: sold with no cost basis. Sale price $200, so at a 40% median ratio
-- the estimate should be $80.
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values ('b0000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-0000000bee00',
        'No cost basis', null, '2025-04-01', 'sold')
on conflict (id) do nothing;
insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values ('d0000000-0000-0000-0000-0000000000a1', 'b0000000-0000-0000-0000-0000000000a1',
        'ebay', 200.00, '2025-04-05')
on conflict (id) do nothing;
insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees, sale_date, status)
values ('c0000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-0000000bee00',
        'b0000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a1',
        200.00, 26.00, '2025-05-01', 'completed')
on conflict (id) do nothing;

-- ISSUE 2: an expense on 'other', which reaches no Schedule C line.
-- ISSUE 5: a $120 expense with no receipt.
-- NOT AN ISSUE: a $12 expense with no receipt, under the threshold.
insert into public.flipdesk_expenses (id, user_id, category, description, amount, spent_on)
values ('e0000000-0000-0000-0000-0000000000b1', 'a0000000-0000-0000-0000-0000000bee00',
        'other', 'Unsorted thing', 55.00, '2025-06-01'),
       ('e0000000-0000-0000-0000-0000000000b2', 'a0000000-0000-0000-0000-0000000bee00',
        'shipping_supplies', 'Big supply order', 120.00, '2025-06-02'),
       ('e0000000-0000-0000-0000-0000000000b3', 'a0000000-0000-0000-0000-0000000bee00',
        'shipping_supplies', 'Small tape order', 12.00, '2025-06-03')
on conflict (id) do nothing;

-- ISSUE 3: an eBay sale with NO fees at all.
-- NOT AN ISSUE: a Facebook local sale with no fees, which is normal.
insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values ('b0000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-0000000bee00',
        'eBay sale missing fees', 30.00, '2025-04-01', 'sold'),
       ('b0000000-0000-0000-0000-0000000000c2', 'a0000000-0000-0000-0000-0000000bee00',
        'Local cash pickup', 30.00, '2025-04-01', 'sold')
on conflict (id) do nothing;
insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values ('d0000000-0000-0000-0000-0000000000c1', 'b0000000-0000-0000-0000-0000000000c1',
        'ebay', 80.00, '2025-04-05'),
       ('d0000000-0000-0000-0000-0000000000c2', 'b0000000-0000-0000-0000-0000000000c2',
        'facebook', 80.00, '2025-04-05')
on conflict (id) do nothing;
insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees, sale_date, status)
values ('c0000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-0000000bee00',
        'b0000000-0000-0000-0000-0000000000c1', 'd0000000-0000-0000-0000-0000000000c1',
        80.00, 0, '2025-07-01', 'completed'),
       ('c0000000-0000-0000-0000-0000000000c2', 'a0000000-0000-0000-0000-0000000bee00',
        'b0000000-0000-0000-0000-0000000000c2', 'd0000000-0000-0000-0000-0000000000c2',
        80.00, 0, '2025-07-02', 'completed')
on conflict (id) do nothing;

-- ISSUE 4: a payout matching no sale.
insert into public.ebay_payouts (id, user_id, payout_id, amount_cents, currency, payout_date)
values ('f0000000-0000-0000-0000-0000000000d1', 'a0000000-0000-0000-0000-0000000bee00',
        'ORPHAN-1', 24500, 'USD', '2025-08-01')
on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-0000000bee00","role":"authenticated"}';

select 'median ratio bps' as q,
       coalesce(public.median_cost_ratio_bps((select auth.uid()))::text, 'null') as a;

select jsonb_pretty(public.books_review_queue('2025-01-01', '2026-01-01')) as queue;

select 'count before dismiss' as q,
       public.books_review_count('2025-01-01', '2026-01-01')::text as a;

insert into public.books_review_dismissals (user_id, issue_kind, subject_id, reason)
values ((select auth.uid()), 'no_cost_basis',
        'b0000000-0000-0000-0000-0000000000a1', 'It was a gift, there was no cost');

select 'count after dismiss' as q,
       public.books_review_count('2025-01-01', '2026-01-01')::text as a;

delete from public.books_review_dismissals
 where issue_kind = 'no_cost_basis'
   and subject_id = 'b0000000-0000-0000-0000-0000000000a1';

select 'count after undismiss' as q,
       public.books_review_count('2025-01-01', '2026-01-01')::text as a;

rollback;
