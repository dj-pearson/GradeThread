-- GradeThread Inventory & Financial Tracking Schema
-- Adds inventory items, listings, sales, and shipments tables

-- ══════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════

CREATE TYPE public.item_status AS ENUM (
  'acquired', 'grading', 'graded', 'listed', 'sold', 'shipped', 'completed', 'returned'
);

CREATE TYPE public.listing_platform AS ENUM (
  'ebay', 'poshmark', 'mercari', 'depop', 'grailed', 'facebook', 'offerup', 'other'
);

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- Inventory Items
CREATE TABLE public.inventory_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title             text NOT NULL,
  brand             text,
  garment_type      public.garment_type,
  garment_category  public.garment_category,
  size              text,
  color             text,
  acquired_price    decimal,
  acquired_date     timestamptz,
  acquired_source   text,
  condition_notes   text,
  status            public.item_status NOT NULL DEFAULT 'acquired',
  submission_id     uuid REFERENCES public.submissions(id) ON DELETE SET NULL,
  grade_report_id   uuid REFERENCES public.grade_reports(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Listings
CREATE TABLE public.listings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id   uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  platform            public.listing_platform NOT NULL,
  platform_listing_id text,
  listing_url         text,
  listing_price       decimal NOT NULL,
  listed_at           timestamptz NOT NULL DEFAULT now(),
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Sales
CREATE TABLE public.sales (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  listing_id        uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  sale_price        decimal NOT NULL,
  platform_fees     decimal NOT NULL DEFAULT 0,
  sale_date         timestamptz NOT NULL DEFAULT now(),
  buyer_username    text,
  buyer_notes       text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Shipments
CREATE TABLE public.shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id         uuid NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  carrier         text NOT NULL,
  tracking_number text,
  shipping_cost   decimal NOT NULL,
  label_cost      decimal NOT NULL DEFAULT 0,
  ship_date       timestamptz,
  delivery_date   timestamptz,
  weight_oz       decimal,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════

-- Inventory Items
CREATE INDEX idx_inventory_items_user_id ON public.inventory_items(user_id);
CREATE INDEX idx_inventory_items_status ON public.inventory_items(status);
CREATE INDEX idx_inventory_items_submission_id ON public.inventory_items(submission_id) WHERE submission_id IS NOT NULL;
CREATE INDEX idx_inventory_items_grade_report_id ON public.inventory_items(grade_report_id) WHERE grade_report_id IS NOT NULL;

-- Listings
CREATE INDEX idx_listings_inventory_item_id ON public.listings(inventory_item_id);
CREATE INDEX idx_listings_platform ON public.listings(platform);
CREATE INDEX idx_listings_is_active ON public.listings(is_active) WHERE is_active = true;

-- Sales
CREATE INDEX idx_sales_inventory_item_id ON public.sales(inventory_item_id);
CREATE INDEX idx_sales_listing_id ON public.sales(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX idx_sales_sale_date ON public.sales(sale_date DESC);

-- Shipments
CREATE INDEX idx_shipments_sale_id ON public.shipments(sale_id);

-- ══════════════════════════════════════════════════════════
-- TRIGGERS
-- ══════════════════════════════════════════════════════════

CREATE TRIGGER set_inventory_items_updated_at
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_listings_updated_at
  BEFORE UPDATE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_shipments_updated_at
  BEFORE UPDATE ON public.shipments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;

-- Inventory Items: own data only
CREATE POLICY "Users can view own inventory items"
  ON public.inventory_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create inventory items"
  ON public.inventory_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own inventory items"
  ON public.inventory_items FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own inventory items"
  ON public.inventory_items FOR DELETE
  USING (auth.uid() = user_id);

-- Listings: via inventory item ownership
CREATE POLICY "Users can view own listings"
  ON public.listings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = listings.inventory_item_id
      AND inventory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create listings"
  ON public.listings FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = listings.inventory_item_id
      AND inventory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own listings"
  ON public.listings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = listings.inventory_item_id
      AND inventory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own listings"
  ON public.listings FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = listings.inventory_item_id
      AND inventory_items.user_id = auth.uid()
    )
  );

-- Sales: via inventory item ownership
CREATE POLICY "Users can view own sales"
  ON public.sales FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = sales.inventory_item_id
      AND inventory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create sales"
  ON public.sales FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = sales.inventory_item_id
      AND inventory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own sales"
  ON public.sales FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = sales.inventory_item_id
      AND inventory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own sales"
  ON public.sales FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = sales.inventory_item_id
      AND inventory_items.user_id = auth.uid()
    )
  );

-- Shipments: via sale -> inventory item ownership
CREATE POLICY "Users can view own shipments"
  ON public.shipments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.sales
      JOIN public.inventory_items ON inventory_items.id = sales.inventory_item_id
      WHERE sales.id = shipments.sale_id
      AND inventory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create shipments"
  ON public.shipments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sales
      JOIN public.inventory_items ON inventory_items.id = sales.inventory_item_id
      WHERE sales.id = shipments.sale_id
      AND inventory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own shipments"
  ON public.shipments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.sales
      JOIN public.inventory_items ON inventory_items.id = sales.inventory_item_id
      WHERE sales.id = shipments.sale_id
      AND inventory_items.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own shipments"
  ON public.shipments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.sales
      JOIN public.inventory_items ON inventory_items.id = sales.inventory_item_id
      WHERE sales.id = shipments.sale_id
      AND inventory_items.user_id = auth.uid()
    )
  );
