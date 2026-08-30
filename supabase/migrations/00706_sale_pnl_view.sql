-- US-3018: one row per completed sale, carrying the profit already computed by
-- finances_dashboard (00143) plus the keys the team reports group by.
--
-- Why a view and not a fourth copy of the arithmetic: the per-sale net exists in
-- exactly two places today -- the `base` CTE inside finances_dashboard, and the
-- eight ledger entries rebuild_ledger_for_user writes (00685). Both are
-- aggregate-shaped: you can ask them for a period total, not for "net by the
-- person who sourced it". This view is that same derivation with the grouping
-- keys left on the row, so the reports read it instead of inventing a third.
--
-- The formula matches finances_dashboard's `net_profit` to the cent, INCLUDING
-- the legacy shipments extra. That last term is easy to miss: `pnl_net` in
-- 00143 omits it and the summary subtracts `ship_extra` separately, so copying
-- `pnl_net` alone would drift on every account that still has shipments rows.
--
-- security_invoker = on, the same as items_full (00010): RLS on sales and
-- inventory_items decides visibility, so a workspace member sees the owner's
-- rows through the policies that already exist and this file adds no tenant
-- logic of its own.

DROP VIEW IF EXISTS public.sale_pnl;

CREATE OR REPLACE VIEW public.sale_pnl
WITH (security_invoker = on)
AS
WITH ship AS (
  -- One shipment per sale, latest wins -- the same rollup 00143 uses.
  SELECT DISTINCT ON (sale_id)
         sale_id, (shipping_cost + label_cost) AS ship_total
    FROM public.shipments
   ORDER BY sale_id, created_at DESC
),
earliest_listing AS (
  SELECT inventory_item_id, min(listed_at) AS listed_at
    FROM public.listings
   GROUP BY inventory_item_id
)
SELECT
  s.id                        AS sale_id,
  s.user_id                   AS user_id,
  s.inventory_item_id         AS inventory_item_id,
  s.sale_date                 AS sale_date,

  -- The person. Case is folded for grouping (sourcer_key) but the display name
  -- keeps whatever they typed, so "Dan" and "dan" aggregate as one row without
  -- the report having to show a lowercased name.
  COALESCE(NULLIF(btrim(i.sourced_by), ''), 'Unassigned')        AS sourcer_name,
  lower(COALESCE(NULLIF(btrim(i.sourced_by), ''), 'Unassigned')) AS sourcer_key,

  -- The shop, brand and category, with 00143's fallback chains unchanged.
  COALESCE(
    NULLIF(btrim(src.name), ''),
    NULLIF(btrim(i.acquired_source), ''),
    'Unknown'
  )                                                         AS source_key,
  COALESCE(NULLIF(btrim(i.brand), ''), 'Unknown')           AS brand_key,
  COALESCE(initcap(i.garment_category::text), 'Unknown')    AS category_key,

  -- computePnl(), term for term.
  (s.sale_price + s.shipping_collected)                     AS revenue,
  (s.platform_fees + s.payment_processing_fees)             AS fees,
  (
    s.shipping_cost + s.grading_cost + s.other_costs
    + CASE WHEN sh.ship_total IS NOT NULL AND COALESCE(s.shipping_cost, 0) = 0
           THEN sh.ship_total ELSE 0 END
  )                                                         AS costs,
  COALESCE(i.acquired_price, 0)                             AS cost_basis,
  (
    (s.sale_price + s.shipping_collected)
    - (s.platform_fees + s.payment_processing_fees)
    - (s.shipping_cost + s.grading_cost + s.other_costs)
    - COALESCE(i.acquired_price, 0)
    - CASE WHEN sh.ship_total IS NOT NULL AND COALESCE(s.shipping_cost, 0) = 0
           THEN sh.ship_total ELSE 0 END
  )                                                         AS net,

  CASE WHEN i.acquired_date IS NOT NULL
       THEN floor(extract(epoch FROM (s.sale_date - i.acquired_date::timestamptz)) / 86400)
  END                                                       AS days_to_sell,
  CASE WHEN el.listed_at IS NOT NULL
       THEN floor(extract(epoch FROM (s.sale_date - el.listed_at::timestamptz)) / 86400)
  END                                                       AS days_on_market

FROM public.sales s
LEFT JOIN public.inventory_items i  ON i.id = s.inventory_item_id
LEFT JOIN ship sh                   ON sh.sale_id = s.id
LEFT JOIN earliest_listing el       ON el.inventory_item_id = s.inventory_item_id
LEFT JOIN public.sources src        ON src.id = i.source_id
WHERE s.status = 'completed';

COMMENT ON VIEW public.sale_pnl IS
  'US-3018: one row per completed sale with the finances_dashboard net profit plus the sourcer, shop, brand and category keys the FlipDesk team reports group by. security_invoker = on, so RLS on sales and inventory_items applies.';

grant select on public.sale_pnl to authenticated;
grant select on public.sale_pnl to service_role;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00706') on conflict do nothing;
