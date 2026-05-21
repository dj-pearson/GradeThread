-- FlipDesk: Reseller Management Platform (native GradeThread integration)
-- Extends existing inventory/listing/sales schema and adds new FlipDesk tables.
-- See FlipDesk_PRD_v1.docx (Pearson Media LLC) for the source-of-truth spec.

-- ══════════════════════════════════════════════════════════
-- ENUM EXTENSIONS
-- ══════════════════════════════════════════════════════════

-- Extend item_status with FlipDesk pipeline statuses.
-- ALTER TYPE ... ADD VALUE is non-transactional in PG <12 but transactional in 12+.
-- Supabase is on PG 15. Use IF NOT EXISTS for idempotency.
ALTER TYPE public.item_status ADD VALUE IF NOT EXISTS 'sourced'      BEFORE 'acquired';
ALTER TYPE public.item_status ADD VALUE IF NOT EXISTS 'cataloged'    AFTER  'acquired';
ALTER TYPE public.item_status ADD VALUE IF NOT EXISTS 'measured'     AFTER  'cataloged';
ALTER TYPE public.item_status ADD VALUE IF NOT EXISTS 'photographed' AFTER  'measured';
ALTER TYPE public.item_status ADD VALUE IF NOT EXISTS 'comped'       AFTER  'graded';
ALTER TYPE public.item_status ADD VALUE IF NOT EXISTS 'drafted'      AFTER  'comped';
ALTER TYPE public.item_status ADD VALUE IF NOT EXISTS 'archived'     AFTER  'returned';

-- Extend listing_platform with marketplaces FlipDesk PRD calls out.
ALTER TYPE public.listing_platform ADD VALUE IF NOT EXISTS 'shopify';
ALTER TYPE public.listing_platform ADD VALUE IF NOT EXISTS 'whatnot';

-- ══════════════════════════════════════════════════════════
-- NEW ENUMS
-- ══════════════════════════════════════════════════════════

CREATE TYPE public.flipdesk_source_type AS ENUM (
  'thrift', 'goodwill_auction', 'estate_sale', 'wholesale',
  'retail_arbitrage', 'consignment', 'other'
);

-- Item-level category (broader than the clothing-specific garment_type).
CREATE TYPE public.item_category AS ENUM (
  'clothing', 'shoes', 'watches', 'sports_cards',
  'collectibles', 'electronics', 'books', 'other'
);

-- Photo classification on an inventory item (separate from grading submission images).
CREATE TYPE public.flipdesk_photo_type AS ENUM (
  'front', 'back', 'tag', 'detail', 'defect', 'flatlay', 'on_model'
);

CREATE TYPE public.listing_status AS ENUM (
  'draft', 'active', 'ended', 'sold', 'relisted'
);

CREATE TYPE public.grading_submission_tier AS ENUM (
  'standard', 'premium', 'express'
);

CREATE TYPE public.payout_import_method AS ENUM (
  'csv_upload', 'api_sync'
);

-- ══════════════════════════════════════════════════════════
-- EXTEND EXISTING TABLES
-- ══════════════════════════════════════════════════════════

-- inventory_items: FlipDesk fields
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS sku             text,
  ADD COLUMN IF NOT EXISTS item_category   public.item_category,
  ADD COLUMN IF NOT EXISTS source_id       uuid,
  ADD COLUMN IF NOT EXISTS target_price    decimal(10,2),
  ADD COLUMN IF NOT EXISTS location_bin    text,
  ADD COLUMN IF NOT EXISTS measurements    jsonb,
  ADD COLUMN IF NOT EXISTS material        text,
  -- Cached grade fields for fast filtering without joining grade_reports
  ADD COLUMN IF NOT EXISTS grade_value     decimal(3,1),
  ADD COLUMN IF NOT EXISTS grade_label     text,
  ADD COLUMN IF NOT EXISTS certificate_url text;

-- SKU must be unique per user when present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_user_sku
  ON public.inventory_items(user_id, sku)
  WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_items_source_id
  ON public.inventory_items(source_id) WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_items_item_category
  ON public.inventory_items(item_category) WHERE item_category IS NOT NULL;

-- listings: FlipDesk fields
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS listing_title       text,
  ADD COLUMN IF NOT EXISTS listing_description text,
  ADD COLUMN IF NOT EXISTS listing_status      public.listing_status NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS watchers            integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS views               integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_listings_listing_status
  ON public.listings(listing_status);

CREATE INDEX IF NOT EXISTS idx_listings_platform_listing_id
  ON public.listings(platform, platform_listing_id)
  WHERE platform_listing_id IS NOT NULL;

-- sales: FlipDesk per-item P&L fields
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS shipping_collected       decimal(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_processing_fees  decimal(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_cost            decimal(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grading_cost             decimal(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_costs              decimal(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS buyer_id                 text,
  ADD COLUMN IF NOT EXISTS sold_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS shipped_at               timestamptz,
  ADD COLUMN IF NOT EXISTS tracking_number          text,
  ADD COLUMN IF NOT EXISTS payout_reference         text;

-- net_profit excludes cost_basis (which lives on inventory_items.acquired_price).
-- Compute net_profit at the application layer or via a view that joins
-- inventory_items. Keep this column writable for cases where the app has
-- already done the math (e.g., reconciliation worker).
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS net_profit decimal(10,2);

CREATE INDEX IF NOT EXISTS idx_sales_payout_reference
  ON public.sales(payout_reference) WHERE payout_reference IS NOT NULL;

-- ══════════════════════════════════════════════════════════
-- NEW TABLES
-- ══════════════════════════════════════════════════════════

-- Sources: where inventory came from (thrift trip, estate, online auction)
CREATE TABLE public.sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  source_type public.flipdesk_source_type NOT NULL DEFAULT 'other',
  location    text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sources_user_id ON public.sources(user_id);
CREATE INDEX idx_sources_source_type ON public.sources(source_type);

CREATE TRIGGER set_sources_updated_at
  BEFORE UPDATE ON public.sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Add deferred FK now that sources exists
ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_source_id_fkey
  FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;

-- Item photos: photo set attached to an inventory item.
-- Distinct from submission_images (which belong to a grading submission).
CREATE TABLE public.item_photos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  photo_url         text NOT NULL,
  storage_path      text,
  photo_type        public.flipdesk_photo_type NOT NULL DEFAULT 'detail',
  sort_order        integer NOT NULL DEFAULT 0,
  used_for_grading  boolean NOT NULL DEFAULT false,
  ebay_uploaded     boolean NOT NULL DEFAULT false,
  archived_to_r2    boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_item_photos_inventory_item_id ON public.item_photos(inventory_item_id);
CREATE INDEX idx_item_photos_photo_type ON public.item_photos(photo_type);

-- Marketplace connections: encrypted OAuth tokens per user per platform.
CREATE TABLE public.marketplace_connections (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  marketplace               public.listing_platform NOT NULL,
  access_token_encrypted    text,
  refresh_token_encrypted   text,
  token_expires_at          timestamptz,
  account_handle            text,
  scopes                    text[] NOT NULL DEFAULT '{}',
  is_active                 boolean NOT NULL DEFAULT true,
  last_synced_at            timestamptz,
  last_refresh_attempt_at   timestamptz,
  refresh_error             text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, marketplace, account_handle)
);

CREATE INDEX idx_marketplace_connections_user_id ON public.marketplace_connections(user_id);
CREATE INDEX idx_marketplace_connections_marketplace ON public.marketplace_connections(marketplace);
CREATE INDEX idx_marketplace_connections_expiry
  ON public.marketplace_connections(token_expires_at)
  WHERE is_active = true;

CREATE TRIGGER set_marketplace_connections_updated_at
  BEFORE UPDATE ON public.marketplace_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Payout imports: rows from marketplace payout CSVs or API syncs, queued for reconciliation.
CREATE TABLE public.payout_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  marketplace   public.listing_platform NOT NULL,
  import_method public.payout_import_method NOT NULL,
  raw_payload   jsonb NOT NULL,
  reconciled    boolean NOT NULL DEFAULT false,
  sale_id       uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  payout_date   date,
  amount        decimal(10,2),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payout_imports_user_id ON public.payout_imports(user_id);
CREATE INDEX idx_payout_imports_reconciled ON public.payout_imports(reconciled);
CREATE INDEX idx_payout_imports_payout_date ON public.payout_imports(payout_date DESC);

CREATE TRIGGER set_payout_imports_updated_at
  BEFORE UPDATE ON public.payout_imports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Grading submissions tracking (FlipDesk-side view onto GradeThread submissions).
-- Holds tier, cost, webhook-timing data per item-to-grading-submission link.
CREATE TABLE public.flipdesk_grading_submissions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id        uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  submission_id            uuid REFERENCES public.submissions(id) ON DELETE SET NULL,
  gradethread_submission_id text,
  tier                     public.grading_submission_tier NOT NULL DEFAULT 'standard',
  status                   public.submission_status NOT NULL DEFAULT 'pending',
  cost                     decimal(10,2) NOT NULL DEFAULT 0,
  submitted_at             timestamptz,
  graded_at                timestamptz,
  webhook_received_at      timestamptz,
  error                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_flipdesk_grading_inventory_item_id
  ON public.flipdesk_grading_submissions(inventory_item_id);
CREATE INDEX idx_flipdesk_grading_status
  ON public.flipdesk_grading_submissions(status);

CREATE TRIGGER set_flipdesk_grading_updated_at
  BEFORE UPDATE ON public.flipdesk_grading_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flipdesk_grading_submissions ENABLE ROW LEVEL SECURITY;

-- Sources: own data only
CREATE POLICY "Users can view own sources"
  ON public.sources FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create sources"
  ON public.sources FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own sources"
  ON public.sources FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own sources"
  ON public.sources FOR DELETE USING (auth.uid() = user_id);

-- Item photos: via inventory item ownership
CREATE POLICY "Users can view own item photos"
  ON public.item_photos FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = item_photos.inventory_item_id
        AND inventory_items.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can create item photos"
  ON public.item_photos FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = item_photos.inventory_item_id
        AND inventory_items.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can update own item photos"
  ON public.item_photos FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = item_photos.inventory_item_id
        AND inventory_items.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can delete own item photos"
  ON public.item_photos FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = item_photos.inventory_item_id
        AND inventory_items.user_id = auth.uid()
    )
  );

-- Marketplace connections: own data only
CREATE POLICY "Users can view own marketplace connections"
  ON public.marketplace_connections FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create marketplace connections"
  ON public.marketplace_connections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own marketplace connections"
  ON public.marketplace_connections FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own marketplace connections"
  ON public.marketplace_connections FOR DELETE USING (auth.uid() = user_id);

-- Payout imports: own data only
CREATE POLICY "Users can view own payout imports"
  ON public.payout_imports FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create payout imports"
  ON public.payout_imports FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own payout imports"
  ON public.payout_imports FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own payout imports"
  ON public.payout_imports FOR DELETE USING (auth.uid() = user_id);

-- FlipDesk grading submissions: via inventory item ownership
CREATE POLICY "Users can view own flipdesk grading submissions"
  ON public.flipdesk_grading_submissions FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = flipdesk_grading_submissions.inventory_item_id
        AND inventory_items.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can create flipdesk grading submissions"
  ON public.flipdesk_grading_submissions FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = flipdesk_grading_submissions.inventory_item_id
        AND inventory_items.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can update own flipdesk grading submissions"
  ON public.flipdesk_grading_submissions FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = flipdesk_grading_submissions.inventory_item_id
        AND inventory_items.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can delete own flipdesk grading submissions"
  ON public.flipdesk_grading_submissions FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = flipdesk_grading_submissions.inventory_item_id
        AND inventory_items.user_id = auth.uid()
    )
  );
