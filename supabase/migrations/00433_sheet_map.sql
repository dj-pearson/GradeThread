-- "Bring your own sheet": a user-defined COLUMN MAP so the Google Sheets sync
-- can drive the seller's OWN tab/layout instead of only the generated,
-- UUID-keyed Inventory/Listings/Sales/Sources tabs.
--
-- The map lives on google_connections (one row per user, owner-readable RLS) so
-- the SPA can render/edit it and the edge service reads it during the merge.
-- NULL = classic mode (the generated fixed tabs, keyed by the hidden flipdesk_id
-- UUID). Non-NULL = mapped mode: sync the named tab, matched/created by a chosen
-- KEY column (the seller's SKU), with a per-column field/table/direction map.
--
-- Shape (validated in edge code, not the DB):
--   {
--     "tab": "Thrift Flip Tracker",
--     "keyColumn": "Item #",          // header of the SKU / match+create key
--     "createFromSheet": true,        // new unique key → create an item (fill-only)
--     "columns": [
--       { "header": "Item #",        "field": "sku",           "table": "inventory_items", "role": "key" },
--       { "header": "Item Title",    "field": "title",         "table": "inventory_items", "writable": true, "kind": "string" },
--       { "header": "Category",      "field": "item_category", "table": "inventory_items", "writable": true, "kind": "enum" },
--       { "header": "Purchase Price","field": "acquired_price","table": "inventory_items", "writable": true, "kind": "currency" },
--       { "header": "Purchase Date", "field": "acquired_date", "table": "inventory_items", "writable": true, "kind": "date" },
--       { "header": "List Price",    "field": "listing_price", "table": "listings",        "writable": false, "kind": "currency" }
--       // ... read-only listing/sale mirror columns ...
--     ]
--   }
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); safe to re-run.

ALTER TABLE public.google_connections
  ADD COLUMN IF NOT EXISTS sheet_map jsonb;

COMMENT ON COLUMN public.google_connections.sheet_map IS
  '"Bring your own sheet" column map. NULL = classic generated-tabs mode (UUID-keyed). Non-NULL = sync the named tab, matched/created by a chosen SKU key column, per the per-column field/table/direction map. Validated in edge code.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00433') ON CONFLICT DO NOTHING;
