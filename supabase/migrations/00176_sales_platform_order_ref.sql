-- US-714: Depop publish / order-sync / mark-as-shipped.
--
-- The Depop ship action (POST /api/v1/orders/{purchase_id}/parcels/{parcel_id}/
-- mark-as-shipped) needs the platform's order + parcel identifiers AFTER a sale
-- has landed, but the `sales` table carries no generic place to hold a
-- marketplace's order reference (the eBay path keeps it on a separate
-- orphan-sales table; Shopify keeps it on payout_imports.raw_payload). Add a
-- nullable jsonb column so any API marketplace can stash the identifiers its
-- fulfillment endpoint needs alongside the sale it created:
--
--   { "platform": "depop", "purchase_id": "...", "parcel_id": "...", "order_id": "..." }
--
-- Generic on purpose (not Depop-specific columns) so eBay/Shopify/future
-- connectors can reuse it. Nullable — existing rows and non-API sales leave it
-- null. No backfill needed.

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS platform_order_ref jsonb;

COMMENT ON COLUMN public.sales.platform_order_ref IS
  'Marketplace order/fulfillment identifiers for API sales (e.g. Depop purchase_id + parcel_id), used by the mark-as-shipped action. NULL for manual/non-API sales.';
