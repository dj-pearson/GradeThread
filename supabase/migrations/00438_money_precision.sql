-- US-1939: give the core money columns explicit cent-level precision.
--
-- 00002 declared acquired_price / listing_price / sale_price / platform_fees /
-- shipping_cost / label_cost as bare `decimal` (arbitrary precision), while
-- columns added later in 00008 use `decimal(10,2)`. Bare `decimal` permits
-- sub-cent values and mismatched scale between joined columns, which can surface
-- rounding drift in the P&L / reconciliation path. Normalize to numeric(10,2)
-- to match the FlipDesk convention, and add non-negative CHECKs where a negative
-- value is impossible (prices, costs, fees).
--
-- Guarded so a re-run is a no-op: the type change fires only while the column is
-- still unbounded (numeric_precision IS NULL), and each CHECK is added only if
-- absent. numeric(10,2) losslessly holds any existing sensible price (max
-- 99,999,999.99); values already stored round to 2dp on the type change.
--
-- DEPENDENCY: the reporting view public.items_full SELECTs acquired_price /
-- listing_price / sale_price / platform_fees / shipping_cost, and Postgres
-- refuses to ALTER TYPE on a column a view depends on ("cannot alter type of a
-- column used by a view or rule"). So we DROP the view, run the type changes,
-- then recreate it verbatim from its current definition (00349). No CASCADE is
-- needed — every other items_full consumer is a FUNCTION (flipdesk_* summaries),
-- which does not create a blocking dependency. Wrapped in one transaction so the
-- view is never observably absent. If a later migration redefines items_full,
-- its CREATE OR REPLACE runs after this in NNNNN order, so the final shape wins.

begin;

drop view if exists public.items_full;

-- consignor_pnl (00304) SELECTs sales.sale_price / sales.platform_fees directly,
-- so it also blocks the type change. Drop it here and recreate it verbatim
-- (with its GRANTs) after the ALTERs. No CASCADE needed — nothing depends on it.
drop view if exists public.consignor_pnl;

-- The grade-outcome sync trigger (00036) fires AFTER UPDATE OF sale_price on
-- public.sales; naming a column in a trigger's column list makes Postgres refuse
-- to ALTER TYPE on it ("cannot alter type of a column used in a trigger
-- definition"). Drop it here and recreate it verbatim after the type change; its
-- function public.sync_grade_outcome_from_sale() is untouched.
drop trigger if exists trg_sales_sync_grade_outcome on public.sales;

do $$
begin
  -- inventory_items.acquired_price
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='inventory_items'
               and column_name='acquired_price' and numeric_precision is null) then
    alter table public.inventory_items alter column acquired_price type numeric(10,2);
  end if;

  -- listings.listing_price
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='listings'
               and column_name='listing_price' and numeric_precision is null) then
    alter table public.listings alter column listing_price type numeric(10,2);
  end if;

  -- sales.sale_price, sales.platform_fees
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='sales'
               and column_name='sale_price' and numeric_precision is null) then
    alter table public.sales alter column sale_price type numeric(10,2);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='sales'
               and column_name='platform_fees' and numeric_precision is null) then
    alter table public.sales alter column platform_fees type numeric(10,2);
  end if;

  -- shipments.shipping_cost, shipments.label_cost
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='shipments'
               and column_name='shipping_cost' and numeric_precision is null) then
    alter table public.shipments alter column shipping_cost type numeric(10,2);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='shipments'
               and column_name='label_cost' and numeric_precision is null) then
    alter table public.shipments alter column label_cost type numeric(10,2);
  end if;
end $$;

-- Recreate items_full verbatim from 00349 (the current definition).
CREATE VIEW public.items_full
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
  sa.sale_price                                                         AS sale_price,
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

-- Recreate the grade-outcome sync trigger dropped above (verbatim from 00036).
CREATE TRIGGER trg_sales_sync_grade_outcome
  AFTER INSERT OR UPDATE OF sale_price, sale_date, listing_id
  ON public.sales
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_grade_outcome_from_sale();

-- Recreate consignor_pnl verbatim from 00304 (the current definition).
CREATE VIEW public.consignor_pnl WITH (security_invoker = true) AS
WITH item_sales AS (
  SELECT
    i.consignor_id,
    i.id                                                        AS item_id,
    i.status                                                    AS item_status,
    COALESCE(i.consignment_split_pct, c.default_split_pct)      AS split_pct,
    s.sale_price                                                AS sale_price,
    -- The sale-price estimate (sale_price − selling fees).
    (COALESCE(s.sale_price, 0)
       - COALESCE(s.platform_fees, 0)
       - COALESCE(s.payment_processing_fees, 0))                AS estimated_net,
    -- The reconciled marketplace payout, when one (or more) payout_imports rows
    -- have been matched to this sale. NULL ⇒ unreconciled ⇒ fall back to estimate.
    pr.reconciled_net                                           AS reconciled_net
  FROM public.inventory_items i
  JOIN public.consignors c ON c.id = i.consignor_id
  LEFT JOIN public.sales s ON s.inventory_item_id = i.id
  LEFT JOIN LATERAL (
    SELECT SUM(pi.amount) AS reconciled_net
    FROM public.payout_imports pi
    WHERE pi.sale_id = s.id AND pi.reconciled = true
    HAVING COUNT(*) > 0
  ) pr ON TRUE
  WHERE i.consignor_id IS NOT NULL
),
priced AS (
  SELECT
    consignor_id,
    item_id,
    item_status,
    split_pct,
    sale_price,
    estimated_net,
    reconciled_net,
    -- Effective net the consignor is paid on: real reconciled payout when known,
    -- else the estimate. This drives net_proceeds + consignor_share.
    COALESCE(reconciled_net, estimated_net)                     AS effective_net,
    (reconciled_net IS NOT NULL)                                AS is_reconciled
  FROM item_sales
),
rollup AS (
  SELECT
    consignor_id,
    COUNT(DISTINCT item_id)                                                     AS total_items,
    COUNT(DISTINCT item_id) FILTER (
      WHERE item_status IN ('sold', 'shipped', 'completed')
    )                                                                          AS items_sold,
    COUNT(DISTINCT item_id) FILTER (WHERE is_reconciled)                       AS items_reconciled,
    COUNT(DISTINCT item_id) FILTER (
      WHERE item_status IN ('sold', 'shipped', 'completed') AND NOT is_reconciled
    )                                                                          AS items_unreconciled,
    COALESCE(SUM(sale_price), 0)                                               AS gross_revenue,
    COALESCE(SUM(effective_net), 0)                                            AS net_proceeds,
    COALESCE(SUM(estimated_net), 0)                                            AS estimated_net_proceeds,
    COALESCE(SUM(reconciled_net), 0)                                           AS reconciled_net_proceeds,
    COALESCE(SUM(effective_net * split_pct / 100.0), 0)                        AS consignor_share,
    COALESCE(SUM(estimated_net * split_pct / 100.0), 0)                        AS estimated_consignor_share,
    COALESCE(SUM(effective_net * (100.0 - split_pct) / 100.0), 0)             AS store_share
  FROM priced
  GROUP BY consignor_id
)
SELECT
  c.id                                                       AS consignor_id,
  c.user_id,
  c.name,
  c.default_split_pct,
  c.status,
  c.payouts_enabled,
  COALESCE(r.total_items, 0)                                 AS total_items,
  COALESCE(r.items_sold, 0)                                  AS items_sold,
  COALESCE(r.gross_revenue, 0)                               AS gross_revenue,
  COALESCE(r.net_proceeds, 0)                                AS net_proceeds,
  COALESCE(r.consignor_share, 0)                             AS consignor_share,
  COALESCE(r.store_share, 0)                                 AS store_share,
  COALESCE(p.payouts_paid, 0)                                AS payouts_paid,
  COALESCE(p.payouts_pending, 0)                             AS payouts_pending,
  GREATEST(COALESCE(r.consignor_share, 0) - COALESCE(p.payouts_paid, 0), 0) AS balance_owed,
  -- US-1123: reconciliation transparency. estimated_* mirror the pre-reconciled
  -- numbers; *_delta = actual − estimate (positive ⇒ the marketplace paid more
  -- than estimated, negative ⇒ less, so an estimate-based payout was over/under).
  COALESCE(r.items_reconciled, 0)                            AS items_reconciled,
  COALESCE(r.items_unreconciled, 0)                          AS items_unreconciled,
  COALESCE(r.estimated_net_proceeds, 0)                      AS estimated_net_proceeds,
  COALESCE(r.reconciled_net_proceeds, 0)                     AS reconciled_net_proceeds,
  COALESCE(r.estimated_consignor_share, 0)                   AS estimated_consignor_share,
  (COALESCE(r.net_proceeds, 0) - COALESCE(r.estimated_net_proceeds, 0))       AS net_proceeds_delta,
  (COALESCE(r.consignor_share, 0) - COALESCE(r.estimated_consignor_share, 0)) AS consignor_share_delta
FROM public.consignors c
LEFT JOIN rollup r ON r.consignor_id = c.id
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)                     AS payouts_paid,
    COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'processing')), 0) AS payouts_pending
  FROM public.consignor_payouts cp
  WHERE cp.consignor_id = c.id
) p ON TRUE;

GRANT SELECT ON public.consignor_pnl TO authenticated;
GRANT SELECT ON public.consignor_pnl TO service_role;

commit;

-- Non-negative CHECKs (idempotent via pg_constraint probe).
do $$
begin
  if not exists (select 1 from pg_constraint where conname='inventory_items_acquired_price_nonneg') then
    alter table public.inventory_items
      add constraint inventory_items_acquired_price_nonneg check (acquired_price >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='listings_listing_price_nonneg') then
    alter table public.listings
      add constraint listings_listing_price_nonneg check (listing_price >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='sales_sale_price_nonneg') then
    alter table public.sales
      add constraint sales_sale_price_nonneg check (sale_price >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='sales_platform_fees_nonneg') then
    alter table public.sales
      add constraint sales_platform_fees_nonneg check (platform_fees >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='shipments_shipping_cost_nonneg') then
    alter table public.shipments
      add constraint shipments_shipping_cost_nonneg check (shipping_cost >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='shipments_label_cost_nonneg') then
    alter table public.shipments
      add constraint shipments_label_cost_nonneg check (label_cost >= 0);
  end if;
end $$;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00438') ON CONFLICT DO NOTHING;
