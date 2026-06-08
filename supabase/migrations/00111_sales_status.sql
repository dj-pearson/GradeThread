-- 00111_sales_status.sql
--
-- Add a cancellation/refund signal to FlipDesk `sales`. Until now the table had
-- NO way to mark a sale cancelled or refunded, so dashboards counted a
-- cancelled (never-shipped) eBay order as a real sale — inflating "sold" counts
-- and net profit on both web and iOS.
--
--   status       'completed' (default) | 'cancelled' | 'refunded' | 'pending'
--   cancelled_at when the cancellation/refund landed (audit + reconciliation)
--
-- The eBay sync (flipdesk-ebay.ts) populates these from the Fulfillment order's
-- cancelStatus / orderPaymentStatus. All metrics MUST exclude status <>
-- 'completed' from revenue, profit, and sold counts.
--
-- Existing rows default to 'completed' (they were real sales); the next eBay
-- sync re-stamps any that are actually cancelled/refunded. Idempotent.

BEGIN;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'cancelled', 'refunded', 'pending')),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN public.sales.status IS
  'Sale lifecycle: completed (real, counts toward revenue/profit/sold), '
  'cancelled (order cancelled, never fulfilled), refunded (fully refunded), '
  'pending. Set by the eBay sync from cancelStatus/orderPaymentStatus. '
  'Metrics exclude anything other than completed.';

-- Partial index: the common metric filter is "exclude non-completed", but the
-- reconciliation views want to find the cancelled/refunded ones fast.
CREATE INDEX IF NOT EXISTS idx_sales_status_not_completed
  ON public.sales(status) WHERE status <> 'completed';

-- Expose the new fields on items_full so web + iOS can filter cancelled sales
-- out of "sold" counts and P&L. Recreate preserving every existing column +
-- the security_invoker setting (see 00033).
CREATE OR REPLACE VIEW public.items_full
WITH (security_invoker = on)
AS
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
  i.updated_at,
  sa.buyer_id                                                            AS buyer_id,
  sa.sold_at                                                             AS sold_at_raw,
  sa.payout_reference                                                    AS payout_reference,
  l.listing_status                                                       AS listing_status,
  l.id                                                                   AS listing_id,
  l.watchers                                                             AS listing_watchers,
  l.views                                                                AS listing_views,
  (
    SELECT count(*)::int FROM public.item_photos p
    WHERE p.inventory_item_id = i.id
  )                                                                      AS photo_count,
  (
    SELECT count(DISTINCT p.photo_type) = 4
    FROM public.item_photos p
    WHERE p.inventory_item_id = i.id
      AND p.photo_type IN ('front', 'back', 'tag', 'detail')
  )                                                                      AS has_required_photos,
  i.ai_field_sources                                                     AS ai_field_sources,
  i.ai_enriched_at                                                       AS ai_enriched_at,
  -- NEW (00111): appended at the END so CREATE OR REPLACE VIEW keeps every
  -- existing column in its original position (Postgres forbids reordering).
  -- Sale lifecycle so callers can drop cancelled/refunded sales.
  sa.status                                                              AS sale_status,
  sa.cancelled_at                                                        AS sale_cancelled_at
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

COMMIT;
