-- US-1828: closet → FlipDesk "list this" bridge (idempotency link).
--
-- When a buyer promotes a closet item into FlipDesk inventory, we record the
-- created inventory_items id on the closet row so a second click returns the
-- existing listing instead of duplicating it, and the portfolio can show a
-- "Listed" state. ON DELETE SET NULL so removing the inventory item just clears
-- the link (the closet item survives).

ALTER TABLE public.closet_items
  ADD COLUMN IF NOT EXISTS promoted_item_id uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL;

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00430')
ON CONFLICT (version) DO NOTHING;
