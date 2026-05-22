-- FlipDesk ⇄ eBay listing sync.
-- Holds a snapshot of the seller's current eBay listings (imported from the
-- eBay Active Listings CSV report, or later via the Sell API). Each row's
-- custom_label is eBay's "Custom label (SKU)" field, which is reconciled
-- against inventory_items.sku to surface SKU mismatches between the two
-- systems on the first pull.

CREATE TABLE public.flipdesk_ebay_listings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  ebay_item_id       text NOT NULL,
  custom_label       text,
  title              text,
  current_price      decimal(12,2),
  available_quantity integer,
  listing_url        text,
  listing_format     text,
  start_date         date,
  matched_item_id    uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  match_status       text NOT NULL DEFAULT 'unmatched'
    CHECK (match_status IN ('matched', 'unmatched', 'ignored')),
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, ebay_item_id)
);

CREATE INDEX idx_flipdesk_ebay_listings_user_id
  ON public.flipdesk_ebay_listings(user_id);
CREATE INDEX idx_flipdesk_ebay_listings_custom_label
  ON public.flipdesk_ebay_listings(user_id, custom_label)
  WHERE custom_label IS NOT NULL;
CREATE INDEX idx_flipdesk_ebay_listings_matched_item
  ON public.flipdesk_ebay_listings(matched_item_id)
  WHERE matched_item_id IS NOT NULL;

CREATE TRIGGER set_flipdesk_ebay_listings_updated_at
  BEFORE UPDATE ON public.flipdesk_ebay_listings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flipdesk_ebay_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ebay listings"
  ON public.flipdesk_ebay_listings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create ebay listings"
  ON public.flipdesk_ebay_listings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own ebay listings"
  ON public.flipdesk_ebay_listings FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own ebay listings"
  ON public.flipdesk_ebay_listings FOR DELETE USING (auth.uid() = user_id);
