-- US-1475: store the adopted eBay catalog product (EPID) on the inventory item.
-- Listing against a catalog product by EPID auto-populates required item
-- specifics + cuts aspect-compliance violations (US-1422). Set via /catalog/adopt
-- and sent in the eBay inventory-item product block at publish.
--
-- Additive column on the existing RLS-scoped inventory_items table.
-- Idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS ebay_epid text;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00328') ON CONFLICT DO NOTHING;
