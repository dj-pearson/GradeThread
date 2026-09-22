-- US-3465: take old imported sales out of the Ship queue.
--
-- The Ship tab lists every completed sale with no shipped_at. US-3209 lets the
-- eBay sync set shipped_at from orderFulfillmentStatus, but a sale that came in
-- from a spreadsheet has no platform_order_id, so no sync will ever speak for
-- it. On prod that left 47 sales from January to June sitting in the queue as
-- "waiting to ship", all of which the owner confirms shipped long ago.
--
-- The rule: completed, never marked shipped, no marketplace order to ask, and
-- sold more than 30 days ago. No marketplace this app reads holds an unshipped
-- order open for 30 days, so an order that old either shipped or was cancelled,
-- and a cancelled one is not status 'completed'.
--
-- shipped_at takes the SALE date. Nothing computes ship speed from shipped_at
-- (checked 2026-09-22), and inventing a later date would be a guess dressed as
-- a fact. tracking_number is left alone for the same reason.
--
-- Idempotent: only rows where shipped_at IS NULL are touched, so a second run
-- matches nothing. Forward only, like resolveShippedAt: an existing shipped_at
-- is never moved.

update public.sales
set shipped_at = coalesce(sold_at, sale_date)
where status = 'completed'
  and shipped_at is null
  and platform_order_id is null
  and coalesce(sold_at, sale_date) is not null
  and coalesce(sold_at, sale_date) < now() - interval '30 days';

insert into public.applied_migrations (version) values ('00823') on conflict do nothing;
