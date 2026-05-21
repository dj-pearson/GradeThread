-- FlipDesk tracking fields: align inventory_items + sales with the user's
-- existing Google Sheet headers so spreadsheet imports map cleanly.
--
-- Sheet headers covered:
--   Container, Item #, Item Title, Item Description, Brand, Style, Size, Notes,
--   Comps, Category, Source, Purchase Date, Purchase Price, Listed, List Date,
--   Links, List Price, Sale Date, Sale Price, Fees, Tax, Shipping Cost,
--   Net Profit, Payout, Status, Days to Sell, Sourced By, Tracking

-- ══════════════════════════════════════════════════════════
-- ENUM EXTENSIONS
-- ══════════════════════════════════════════════════════════

-- Personal-use statuses: items the user is keeping/wearing rather than selling.
-- These live in a side-track view (not in the main Kanban pipeline).
ALTER TYPE public.item_status ADD VALUE IF NOT EXISTS 'keeping' AFTER 'archived';
ALTER TYPE public.item_status ADD VALUE IF NOT EXISTS 'wearing' AFTER 'keeping';

-- ══════════════════════════════════════════════════════════
-- inventory_items: tracking fields
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.inventory_items
  -- Physical storage label (free-form: "Bin A1", "Closet shelf 3", "Garage tote 4")
  ADD COLUMN IF NOT EXISTS container text,
  -- Brand style / model name (e.g., "Align Pant", "Air Jordan 1")
  ADD COLUMN IF NOT EXISTS style text,
  -- Public-facing description (lives in listings later; kept here for spreadsheet parity)
  ADD COLUMN IF NOT EXISTS description text,
  -- For shared accounts: who acquired this item ("Dan", "Spouse", "Joint")
  ADD COLUMN IF NOT EXISTS sourced_by text,
  -- Array of comp records: [{ price, source, url, sold_date, notes }, ...]
  ADD COLUMN IF NOT EXISTS comp_set jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_inventory_items_container
  ON public.inventory_items(container) WHERE container IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_items_sourced_by
  ON public.inventory_items(sourced_by) WHERE sourced_by IS NOT NULL;

-- ══════════════════════════════════════════════════════════
-- sales: tax + explicit payout amount
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS tax decimal(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_amount decimal(10,2);

-- ══════════════════════════════════════════════════════════
-- VIEW: items_full
-- One row per inventory item with the joined listing + sale columns the
-- spreadsheet view needs. Falls back to the most-recently-listed listing
-- and the linked sale (if any).
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.items_full AS
SELECT
  i.id,
  i.user_id,
  i.sku                                                                  AS item_number,
  i.container,
  i.title                                                                AS item_title,
  i.description                                                          AS item_description,
  i.brand,
  i.style,
  i.size,
  i.condition_notes                                                      AS notes,
  i.comp_set                                                             AS comps,
  COALESCE(i.item_category::text, i.garment_category::text)              AS category,
  s.name                                                                 AS source_name,
  i.source_id,
  i.sourced_by,
  i.acquired_date                                                        AS purchase_date,
  i.acquired_price                                                       AS purchase_price,
  (l.id IS NOT NULL)                                                     AS listed,
  l.listed_at                                                            AS list_date,
  l.listing_url                                                          AS link,
  l.listing_price                                                        AS list_price,
  COALESCE(sa.sold_at, sa.sale_date)                                     AS sale_date,
  sa.sale_price                                                          AS sale_price,
  COALESCE(sa.platform_fees, 0) + COALESCE(sa.payment_processing_fees, 0) AS fees,
  sa.tax                                                                 AS tax,
  sa.shipping_cost                                                       AS shipping_cost,
  sa.net_profit                                                          AS net_profit,
  sa.payout_amount                                                       AS payout,
  i.status                                                               AS status,
  -- Days to Sell: list_date → sale_date when both present
  CASE
    WHEN l.listed_at IS NOT NULL AND COALESCE(sa.sold_at, sa.sale_date) IS NOT NULL
      THEN EXTRACT(DAY FROM (COALESCE(sa.sold_at, sa.sale_date) - l.listed_at))::int
    ELSE NULL
  END                                                                    AS days_to_sell,
  sa.tracking_number                                                     AS tracking,
  i.target_price,
  i.grade_value,
  i.grade_label,
  i.certificate_url,
  i.measurements,
  i.location_bin,
  i.created_at,
  i.updated_at
FROM public.inventory_items i
LEFT JOIN public.sources s ON s.id = i.source_id
LEFT JOIN LATERAL (
  SELECT * FROM public.listings
  WHERE listings.inventory_item_id = i.id
  ORDER BY listings.listed_at DESC NULLS LAST, listings.created_at DESC
  LIMIT 1
) l ON true
LEFT JOIN LATERAL (
  SELECT * FROM public.sales
  WHERE sales.inventory_item_id = i.id
  ORDER BY COALESCE(sales.sold_at, sales.sale_date) DESC NULLS LAST,
           sales.created_at DESC
  LIMIT 1
) sa ON true;

-- View inherits RLS from the underlying inventory_items table; ensure callers
-- query as the authed user so their own rows surface.

-- ══════════════════════════════════════════════════════════
-- HELPER FUNCTION: get_or_create_source
-- Used by the bulk-import flow to dedupe sources by name per user.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_or_create_source(
  p_user_id uuid,
  p_name text,
  p_source_type public.flipdesk_source_type DEFAULT 'other'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_id
  FROM public.sources
  WHERE user_id = p_user_id AND lower(name) = lower(trim(p_name))
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO public.sources (user_id, name, source_type)
  VALUES (p_user_id, trim(p_name), p_source_type)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_source(uuid, text, public.flipdesk_source_type) TO authenticated;
