-- Consignment model (US-676) — resellers who sell on behalf of consignors need
-- to track who owns each item and what cut they're owed when it sells.
--
-- Owner-scoped, mirroring listing_templates/repricing_rules (00105/00106): the
-- workspace owner owns the consignor records; members read them through the edge
-- (service-role client + explicit workspace scoping per CLAUDE.md US-268) or
-- directly under RLS as the owner. iOS reads/writes these directly via
-- supabase-swift under RLS (same path as ConsignorService).
--
-- inventory_items already carries `location_bin` (00008) for storage location /
-- bin tracking; this migration adds the consignment link + split. SKU/barcode
-- label printing is a pure-client (AirPrint) concern with no schema change.

CREATE TABLE public.consignors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name                text NOT NULL,
  contact_email       text,
  contact_phone       text,
  -- Consignor's default share of NET sale proceeds (0..100). Per-item splits
  -- (inventory_items.consignment_split_pct) override this when set.
  default_split_pct   numeric(5,2) NOT NULL DEFAULT 50
                        CHECK (default_split_pct >= 0 AND default_split_pct <= 100),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Names are unique per owner so the picker is unambiguous.
  UNIQUE (user_id, name)
);

CREATE INDEX idx_consignors_user_id
  ON public.consignors(user_id);

CREATE TRIGGER set_consignors_updated_at
  BEFORE UPDATE ON public.consignors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.consignors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own consignors"
  ON public.consignors FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create consignors"
  ON public.consignors FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own consignors"
  ON public.consignors FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own consignors"
  ON public.consignors FOR DELETE USING (auth.uid() = user_id);

-- Link items to a consignor + an optional per-item split override. ON DELETE
-- SET NULL so removing a consignor doesn't cascade-delete their (sold) items —
-- the sale history stays intact, the item just loses the consignor pointer.
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS consignor_id uuid
    REFERENCES public.consignors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consignment_split_pct numeric(5,2)
    CHECK (consignment_split_pct IS NULL
           OR (consignment_split_pct >= 0 AND consignment_split_pct <= 100));

CREATE INDEX IF NOT EXISTS idx_inventory_items_consignor_id
  ON public.inventory_items(consignor_id)
  WHERE consignor_id IS NOT NULL;
