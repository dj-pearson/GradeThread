-- US-3110: two markers that let the eBay sync stop re-reading what it already knows.
--
-- marketplace_connections.last_catalog_synced_at — when the full offer catalog
-- was last read from eBay. The order backstop and the notification-driven sync
-- consult it so an orders-only pull can skip the per-SKU offer fan-out.
--
-- inventory_items.ebay_specifics_checked_at — when GetItem was last asked for
-- this item's specifics. Without it a field eBay cannot fill stays blank, so
-- every sync re-asks forever.

alter table public.marketplace_connections
  add column if not exists last_catalog_synced_at timestamptz;

comment on column public.marketplace_connections.last_catalog_synced_at is
  'When the full eBay offer catalog was last pulled for this connection. Null means never. Orders-only syncs upgrade themselves to a full pull once this goes stale.';

alter table public.inventory_items
  add column if not exists ebay_specifics_checked_at timestamptz;

comment on column public.inventory_items.ebay_specifics_checked_at is
  'When eBay GetItem was last asked for this item''s specifics, whether or not it returned anything. Negative cache: a blank field eBay has no value for must not be re-fetched every sync.';

-- Stalest-first selection in the order backstop orders by this column.
create index if not exists idx_marketplace_connections_catalog_synced
  on public.marketplace_connections (marketplace, last_catalog_synced_at nulls first)
  where is_active;

-- The marketplace-event sweep polled six eBay endpoints for every connected
-- seller every fifteen minutes, whether or not that seller had anything a
-- return, dispute, cancellation, inquiry, case or Best Offer could attach to.
-- That is 576 calls per seller per day of fixed cost, so a dormant trial
-- account costs exactly as much quota as the busiest shop.
--
-- This narrows the sweep to owners who could actually have an event: an active
-- eBay listing (a Best Offer can arrive), a recent sale (a return or dispute
-- can be opened), or an open case still being worked. Anything outside that is
-- still reachable — eBay's return-bucket notification triggers a direct poll for
-- the named seller regardless of this gate.
--
-- Runs as the caller's definer so one round trip answers for every owner; the
-- edge calls it with the service-role key, and it is revoked from everyone else
-- because it returns other tenants' owner ids by design.
create or replace function public.pollable_ebay_owner_ids(p_since timestamptz)
returns table (owner_user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select c.user_id
  from public.marketplace_connections c
  where c.marketplace = 'ebay'
    and c.is_active
    and (
      exists (
        select 1 from public.listings l
        where l.user_id = c.user_id and l.platform = 'ebay' and l.is_active
      )
      or exists (
        select 1 from public.sales s
        where s.user_id = c.user_id and s.created_at >= p_since
      )
      or exists (
        select 1 from public.marketplace_post_sale_cases k
        where k.user_id = c.user_id and k.closed_at is null
      )
    )
  group by c.user_id;
$$;

revoke all on function public.pollable_ebay_owner_ids(timestamptz) from public;
revoke all on function public.pollable_ebay_owner_ids(timestamptz) from anon;
revoke all on function public.pollable_ebay_owner_ids(timestamptz) from authenticated;
grant execute on function public.pollable_ebay_owner_ids(timestamptz) to service_role;

-- Supports the three EXISTS probes above.
create index if not exists idx_listings_owner_active_platform
  on public.listings (user_id, platform)
  where is_active;

create index if not exists idx_sales_owner_created
  on public.sales (user_id, created_at desc);

insert into public.applied_migrations (version) values ('00724') on conflict do nothing;
