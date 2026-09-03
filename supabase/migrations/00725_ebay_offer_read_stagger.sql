-- US-3111: stagger the per-SKU eBay offer read.
--
-- listAllOffers fans out one `GET /sell/inventory/v1/offer?sku=` per SKU across
-- eBay's entire inventory list — 984 SKUs — on every full catalog pass. Most of
-- those SKUs have no Inventory-API offer at all (301 of 940 eBay listing rows
-- carry an offer id; the rest are Seller-Hub listings created through Trading),
-- so the call returns nothing, we store nothing, and we ask again six hours
-- later. The same shape as the item-specifics bug 00724 fixed.
--
-- This column remembers that we asked. Price, quantity, title, category and
-- listing status for ACTIVE listings keep arriving from GetMyeBaySelling in
-- about seven paged calls per pass, so nothing a seller sees goes stale; what
-- moves to a daily cadence is the offer-level detail and the detection of a
-- listing that ended without selling.

alter table public.inventory_items
  add column if not exists ebay_offer_checked_at timestamptz;

comment on column public.inventory_items.ebay_offer_checked_at is
  'When this SKU''s eBay offer was last read, whether or not eBay returned one. Negative cache: a SKU with no Inventory-API offer must not be re-read every catalog pass. Null means never asked, which always forces a read.';

insert into public.applied_migrations (version) values ('00725') on conflict do nothing;
