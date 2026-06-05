-- Orphan eBay sales — sales pulled from the Fulfillment API whose line item
-- could NOT be matched to a FlipDesk inventory_item (no SKU match and no eBay
-- item-id match). Previously these were silently dropped (salesSkipped++),
-- which left the Sold totals understated and made "pull my full sales" lossy.
-- We now snapshot them here so the user can reconcile them on the
-- Reconciliation page, mirroring flipdesk_ebay_listings for orphan listings.

CREATE TABLE public.flipdesk_ebay_orphan_sales (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform_order_id  text NOT NULL,
  line_item_id       text NOT NULL DEFAULT '',
  ebay_item_id       text,          -- order line item's legacyItemId
  sku                text,          -- order line item's Custom Label, if any
  title              text,
  sale_price         decimal(12,2),
  shipping_collected decimal(12,2),
  tax                decimal(12,2),
  buyer_username     text,
  sold_at            timestamptz,
  currency           text NOT NULL DEFAULT 'USD',
  matched_item_id    uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  match_status       text NOT NULL DEFAULT 'unmatched'
    CHECK (match_status IN ('matched', 'unmatched', 'ignored')),
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform_order_id, line_item_id)
);

CREATE INDEX idx_flipdesk_ebay_orphan_sales_user_id
  ON public.flipdesk_ebay_orphan_sales(user_id);
CREATE INDEX idx_flipdesk_ebay_orphan_sales_ebay_item
  ON public.flipdesk_ebay_orphan_sales(user_id, ebay_item_id)
  WHERE ebay_item_id IS NOT NULL;
CREATE INDEX idx_flipdesk_ebay_orphan_sales_sku
  ON public.flipdesk_ebay_orphan_sales(user_id, sku)
  WHERE sku IS NOT NULL;
CREATE INDEX idx_flipdesk_ebay_orphan_sales_matched_item
  ON public.flipdesk_ebay_orphan_sales(matched_item_id)
  WHERE matched_item_id IS NOT NULL;

CREATE TRIGGER set_flipdesk_ebay_orphan_sales_updated_at
  BEFORE UPDATE ON public.flipdesk_ebay_orphan_sales
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flipdesk_ebay_orphan_sales ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own orphan sales"
  ON public.flipdesk_ebay_orphan_sales FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create orphan sales"
  ON public.flipdesk_ebay_orphan_sales FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own orphan sales"
  ON public.flipdesk_ebay_orphan_sales FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own orphan sales"
  ON public.flipdesk_ebay_orphan_sales FOR DELETE USING (auth.uid() = user_id);
