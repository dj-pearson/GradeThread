-- US-3413: payout becomes a grouping key on sale_pnl, beside sourcer, shop,
-- brand and category.
--
-- The view already answers "net by the person who sourced it". It could not
-- answer "what did THIS deposit pay each person", which is the question a
-- multi-sourcer shop actually asks, because the payout id lived only on
-- public.sales and the view did not carry it.
--
-- Two columns, both straight passthroughs:
--   payout_id    - sales.payout_reference, the eBay payoutId. Null until the
--                  deposit settles and the link pass finds it.
--   payout_date  - the deposit date from public.ebay_payouts, when we hold the
--                  header. Null when we hold the reference but not the header,
--                  which is a real state: references are written by the sync,
--                  headers only arrive when the payouts endpoint is read.
--
-- NOTHING about the money changes. The revenue/fees/costs/net terms below are
-- copied verbatim from 00706 so scripts/check-sale-pnl-invariant.mjs keeps
-- agreeing with finances_dashboard to the cent. A view cannot be ALTERed to add
-- a column in the middle, so the whole body is restated; diff it against 00706
-- and the only additions are the two columns and the ebay_payouts join.
--
-- The join is LEFT and keyed on BOTH user_id and payout_id. Keying on payout_id
-- alone would be a cross-tenant join in a security_invoker view: RLS on
-- ebay_payouts would still hide the other tenant's row, so the practical result
-- is a null rather than a leak, but a join predicate that only works because a
-- policy catches it is not one to write down.

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

  -- US-3413: the deposit this sale settled in. Null until it settles.
  NULLIF(btrim(s.payout_reference), '')                     AS payout_id,
  p.payout_date                                             AS payout_date,

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
LEFT JOIN public.ebay_payouts p     ON p.user_id = s.user_id
                                   AND p.payout_id = NULLIF(btrim(s.payout_reference), '')
WHERE s.status = 'completed';

COMMENT ON VIEW public.sale_pnl IS
  'US-3018/US-3413: one row per completed sale with the finances_dashboard net profit plus the sourcer, shop, brand, category and payout keys the FlipDesk team reports group by. security_invoker = on, so RLS on sales and inventory_items applies.';

grant select on public.sale_pnl to authenticated;
grant select on public.sale_pnl to service_role;

-- The payout breakdown reads sale_pnl filtered by (user_id, payout_id). The
-- view cannot be indexed, so the index goes on the base column the filter
-- pushes down to. 00008 already indexes payout_reference alone; this one is
-- tenant-first, which is the shape every read in the report has.
CREATE INDEX IF NOT EXISTS idx_sales_user_payout_reference
  ON public.sales(user_id, payout_reference)
  WHERE payout_reference IS NOT NULL;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00801') on conflict do nothing;
