-- US-1999: pin the eBay Inventory SKU a listing was PUBLISHED under.
--
-- eBay's Inventory API addresses items by SKU. GradeThread derived that key at
-- three call sites from inventory_items.sku — a freely seller-editable column
-- (it is in GRADETHREAD_OWNED_ITEM_FIELDS and the item canvas renders it as a
-- plain text field). Renaming the SKU of an item with a live listing made every
-- later Inventory call address a key eBay never had: createOrReplaceInventoryItem
-- created a NEW orphan inventory item while the offer-id-keyed calls still hit
-- the real offer. Split-brain listing, no error surfaced.
--
-- The SKU is listing state, not item state, so it lives on the listing row.
-- After this, inventory_items.sku is once again just the seller's item number
-- and editing it cannot orphan anything.
--
-- Also unblocks US-1968 (bulk_migrate_listing returns eBay's OWN sku per
-- listing and had nowhere to put it).

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS inventory_sku text;

COMMENT ON COLUMN public.listings.inventory_sku IS
  'US-1999: the eBay Inventory API SKU this listing was actually published '
  'under. AUTHORITATIVE for every later Inventory call (revise, reprice, '
  'withdraw, relist, promote) — never re-derive from inventory_items.sku, '
  'which the seller can edit. NULL = never published through the Inventory '
  'API (draft), or an eBay-originated mirror whose SKU is eBay''s own.';

-- Adoption/reconciliation looks a listing up by the SKU eBay reports as the
-- "custom label"; US-1968''s bulk migration will do the same with eBay''s own
-- SKUs. Partial (SKU is NULL for every draft) and tenant-scoped.
CREATE INDEX IF NOT EXISTS idx_listings_user_inventory_sku
  ON public.listings (user_id, inventory_sku)
  WHERE inventory_sku IS NOT NULL;

-- Backfill: rows that are ALREADY live have no stored SKU, so reproduce the
-- rule the code used at publish time.
--
-- ⚠ HONEST LIMITATION (US-1999 AC3): this preserves today's derivation, which
-- is only correct for rows whose inventory_items.sku has NOT changed since
-- publish. A row whose SKU was edited post-publish is ALREADY mismatched
-- against eBay, and nothing stored locally records what it went live as — the
-- backfill cannot recover it and will pin the WRONG value. That is not a
-- regression (the code re-derived the same wrong value on every call); it just
-- makes the existing breakage explicit and fixable. Such a listing is
-- identified by the eBay pull-sync as an orphan (its custom_label matches no
-- local listing) and is repaired via the Reconciliation page, which is the
-- correct owner of that repair. Deliberately scoped to published rows only:
-- drafts get their SKU at publish, when it is knowable rather than guessed.
UPDATE public.listings AS l
SET inventory_sku = COALESCE(NULLIF(TRIM(i.sku), ''), 'FD-' || LEFT(i.id::text, 8))
FROM public.inventory_items AS i
WHERE i.id = l.inventory_item_id
  AND l.inventory_sku IS NULL
  AND l.platform = 'ebay'
  AND l.platform_offer_id IS NOT NULL
  -- eBay-originated mirrors are addressed by eBay's own SKU, which arrives via
  -- the pull-sync; do not stamp a GradeThread-derived key onto them.
  AND COALESCE(l.listing_origin, 'gradethread') <> 'ebay';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00477') ON CONFLICT DO NOTHING;
