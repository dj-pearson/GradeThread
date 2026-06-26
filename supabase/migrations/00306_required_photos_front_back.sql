-- 00306_required_photos_front_back.sql
--
-- Relax the "required photos" gate from {front, back, tag, detail} to
-- {front, back}. Tag + Detail remain encouraged default capture slots but are
-- no longer mandatory: many garments legitimately have no readable tag (e.g.
-- Lululemon's size label is commonly cut off), so requiring one wrongly blocked
-- the item from advancing to "photographed" and from grading.
--
-- The only change vs 00250 is the `has_required_photos` sub-select: it now
-- counts DISTINCT photo_type = 2 over ('front', 'back') instead of = 4 over
-- ('front', 'back', 'tag', 'detail'). The client-side mirrors are updated in
-- the same commit (src/lib/constants.ts REQUIRED_PHOTO_TYPES, the edge + web
-- photo profiles, and iOS PhotoSlotType).
--
-- CREATE OR REPLACE VIEW forbids reordering/renaming/removing existing columns,
-- so every column below is reproduced in its exact position from 00250; only
-- the has_required_photos expression changes. items_full stays security_invoker
-- (00033/00249), so joined columns are only visible for the caller's own rows.
-- Idempotent.

BEGIN;

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
  -- Prefer the stored URL; otherwise derive it from the eBay item id so the
  -- "Link" cell is populated whenever we know which eBay listing it is.
  COALESCE(
    NULLIF(l.listing_url, ''),
    CASE
      WHEN l.platform_listing_id IS NOT NULL AND l.platform_listing_id <> ''
        THEN 'https://www.ebay.com/itm/' || l.platform_listing_id
      ELSE NULL
    END
  )                                                                      AS link,
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
  -- CHANGED (00306): only Front + Back are required now (was front/back/tag/detail).
  (
    SELECT count(DISTINCT p.photo_type) = 2
    FROM public.item_photos p
    WHERE p.inventory_item_id = i.id
      AND p.photo_type IN ('front', 'back')
  )                                                                      AS has_required_photos,
  i.ai_field_sources                                                     AS ai_field_sources,
  i.ai_enriched_at                                                       AS ai_enriched_at,
  sa.status                                                              AS sale_status,
  sa.cancelled_at                                                        AS sale_cancelled_at,
  -- US-1051: color (inventory_items) + most-recent listing marketplace.
  i.color                                                                AS color,
  l.platform                                                             AS listing_platform,
  -- US-960: Shipped-tab fulfillment surfaced from the most-recent sale.
  sa.carrier                                                             AS carrier,
  sa.shipped_at                                                          AS shipped_at,
  sa.delivered_at                                                        AS delivered_at
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

INSERT INTO public.applied_migrations (version) VALUES ('00306') ON CONFLICT DO NOTHING;
