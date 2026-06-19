-- 00266_flipdesk_expenses_item_link.sql
--
-- US-750: single source of truth for Sales + Expenses on iOS. The Expenses half
-- needs each expense to optionally point at the inventory item (and/or listing)
-- it offsets, so per-item P&L and expense-by-source reporting become possible —
-- today `flipdesk_expenses` (00019) only models business-wide overhead with no
-- way to attribute a cost to the thing it was spent on.
--
-- Two nullable foreign keys:
--   • inventory_item_id — the item this expense offsets (e.g. a repair, a
--                         dry-clean, sourcing cost for one piece). NULL = general
--                         overhead, the existing behavior.
--   • listing_id        — the listing this expense is tied to (e.g. a promoted-
--                         listing fee). NULL = not listing-specific.
--
-- Both ON DELETE SET NULL: deleting the item/listing must NOT delete the
-- expense — the money was still spent; it just becomes unattributed overhead.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS indexes. Fresh-schema
-- safe (the table + referenced tables already exist by this point).

BEGIN;

ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS inventory_item_id uuid
    REFERENCES public.inventory_items(id) ON DELETE SET NULL;

ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS listing_id uuid
    REFERENCES public.listings(id) ON DELETE SET NULL;

-- Partial indexes so per-item / per-listing expense roll-ups stay cheap and the
-- index only carries the rows that are actually attributed.
CREATE INDEX IF NOT EXISTS idx_flipdesk_expenses_inventory_item_id
  ON public.flipdesk_expenses(inventory_item_id)
  WHERE inventory_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_flipdesk_expenses_listing_id
  ON public.flipdesk_expenses(listing_id)
  WHERE listing_id IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync.
INSERT INTO public.applied_migrations (version) VALUES ('00266')
ON CONFLICT (version) DO NOTHING;

COMMIT;
