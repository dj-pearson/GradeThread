-- 00349_draft_review_lifecycle.sql
--
-- US-1568/US-1569: the unified drafts lifecycle.
--
-- 1. listings.reviewed_at — the "a human looked at this draft" marker. Set by
--    the composer's Save (and the bulk-edit save); CLEARED when a regeneration
--    overwrites the draft (ai-listing.ts writes reviewed_at = null in
--    draftFields). The AutoLister drafts cockpit becomes the
--    'AI-processed, not yet human-reviewed' queue by filtering
--    reviewed_at IS NULL; reviewed drafts live on in Inventory → Drafts.
--
-- 2. items_full gains the draft-review fields (listing_needs_review,
--    listing_reviewed_at, listing_title) so Inventory → Drafts rows can show
--    the review badge and the generated listing title without a per-row
--    listings query. CREATE OR REPLACE VIEW forbids reordering/renaming/
--    removing existing columns, so every column below is reproduced in its
--    exact position from 00306; the new columns are appended at the END.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE VIEW.

BEGIN;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

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
  i.color                                                                AS color,
  l.platform                                                             AS listing_platform,
  sa.carrier                                                             AS carrier,
  sa.shipped_at                                                          AS shipped_at,
  sa.delivered_at                                                        AS delivered_at,
  -- NEW (00349): draft-review fields for the unified drafts surfaces.
  l.needs_review                                                         AS listing_needs_review,
  l.reviewed_at                                                          AS listing_reviewed_at,
  l.listing_title                                                        AS listing_title
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

INSERT INTO public.applied_migrations (version) VALUES ('00349') ON CONFLICT DO NOTHING;
