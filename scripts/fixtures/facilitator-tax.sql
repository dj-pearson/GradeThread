-- US-2987 -- the two sales-tax branches, exercised against real Postgres.
--
-- Run it with: node scripts/check-facilitator-tax.mjs
--
-- Two identical sales, same price, same tax, different platform:
--
--   eBay     a marketplace facilitator. The tax was never the seller's income,
--            so it lands on the EXCLUDED account, reaches no Schedule C line,
--            and gross receipts are the sale price alone.
--   Shopify  NOT a facilitator. The seller is the retailer, so the tax is part
--            of gross receipts (line 1) AND the remittance is a deduction
--            (line 23). Two entries that net to zero.
--
-- NET PROFIT IS THE SAME EITHER WAY, and that is exactly why this needs a test
-- rather than an eyeball: the bottom line cannot tell you the branch was
-- chosen correctly. GROSS RECEIPTS can, and that is the figure a 1099-K is
-- compared against.
--
-- A third sale has a NULL listing, which is reachable because
-- sales.listing_id is ON DELETE SET NULL. It must take the conservative
-- seller-collected branch: overstating income is a number the seller can
-- dispute, understating it is one the IRS disputes.
begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-0000000fac00', 'facilitator@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values
 ('b0000000-0000-0000-0000-0000000fac01', 'a0000000-0000-0000-0000-0000000fac00',
  'Sold on eBay', 20.00, '2026-01-05', 'sold'),
 ('b0000000-0000-0000-0000-0000000fac02', 'a0000000-0000-0000-0000-0000000fac00',
  'Sold on my own store', 20.00, '2026-01-05', 'sold'),
 ('b0000000-0000-0000-0000-0000000fac03', 'a0000000-0000-0000-0000-0000000fac00',
  'Listing since deleted', 20.00, '2026-01-05', 'sold')
on conflict (id) do nothing;

insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values
 ('d0000000-0000-0000-0000-0000000fac01', 'b0000000-0000-0000-0000-0000000fac01',
  'ebay', 100.00, '2026-01-10'),
 ('d0000000-0000-0000-0000-0000000fac02', 'b0000000-0000-0000-0000-0000000fac02',
  'shopify', 100.00, '2026-01-10')
on conflict (id) do nothing;

-- Identical money on all three. Only the platform differs.
insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees,
   shipping_collected, tax, sale_date, status)
values
 ('c0000000-0000-0000-0000-0000000fac01', 'a0000000-0000-0000-0000-0000000fac00',
  'b0000000-0000-0000-0000-0000000fac01', 'd0000000-0000-0000-0000-0000000fac01',
  100.00, 13.00, 0, 8.25, '2026-02-01', 'completed'),
 ('c0000000-0000-0000-0000-0000000fac02', 'a0000000-0000-0000-0000-0000000fac00',
  'b0000000-0000-0000-0000-0000000fac02', 'd0000000-0000-0000-0000-0000000fac02',
  100.00, 13.00, 0, 8.25, '2026-02-01', 'completed'),
 ('c0000000-0000-0000-0000-0000000fac03', 'a0000000-0000-0000-0000-0000000fac00',
  'b0000000-0000-0000-0000-0000000fac03', NULL,
  100.00, 13.00, 0, 8.25, '2026-02-01', 'completed')
on conflict (id) do nothing;

select public.rebuild_ledger_for_user('a0000000-0000-0000-0000-0000000fac00');

-- The rule itself, asked directly.
select 'ebay 2026'    as q, public.is_facilitator_collected('ebay',    date '2026-02-01') as a
union all select 'shopify 2026', public.is_facilitator_collected('shopify', date '2026-02-01')
union all select 'other 2026',   public.is_facilitator_collected('other',   date '2026-02-01')
union all select 'ebay 2019 (before the rule)',
                 public.is_facilitator_collected('ebay',    date '2019-06-01');

-- Where the tax landed, per sale.
select
  coalesce(l.platform::text, 'no listing') as platform,
  a.code,
  a.schedule_c_line,
  e.amount_cents,
  e.source_detail
from public.ledger_entries e
join public.ledger_accounts a on a.id = e.account_id
join public.sales s on s.id = e.source_id
left join public.listings l on l.id = s.listing_id
where e.user_id = 'a0000000-0000-0000-0000-0000000fac00'
  and e.source_detail in ('tax', 'tax_remitted')
order by 1, 2;

-- Gross receipts per platform: the figure that tells the branches apart.
select
  coalesce(l.platform::text, 'no listing') as platform,
  sum(e.amount_cents) filter (where a.flow = 'income')   as gross_receipts_cents,
  sum(e.amount_cents) filter (where a.flow = 'excluded') as excluded_cents,
  sum(e.amount_cents) filter (where a.flow <> 'excluded' and a.flow <> 'asset')
                                                        as net_cents
from public.ledger_entries e
join public.ledger_accounts a on a.id = e.account_id
join public.sales s on s.id = e.source_id
left join public.listings l on l.id = s.listing_id
where e.user_id = 'a0000000-0000-0000-0000-0000000fac00'
group by 1
order by 1;

rollback;
