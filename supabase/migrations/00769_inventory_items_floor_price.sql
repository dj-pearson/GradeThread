-- US-3192: the price a seller will not go below on THIS garment.
--
-- Until now the only floor was a percentage on a rule: margin_floor_pct on an
-- automation, floor_price_cents on a repricing rule. Both are recomputed per
-- run from the item's cost basis, which means three things a seller cannot do.
-- They cannot say "never below $28 on this jacket" and have it hold. They
-- cannot floor an item whose cost basis is unknown, because a percentage of
-- nothing is nothing. And they cannot have one number respected by markdowns,
-- offer rules and bulk reduce alike, because each of those computes its own.
--
-- ON THE ITEM, NOT THE LISTING, because it is a fact about the garment and the
-- money in it, not about one marketplace's copy of it. A seller who will not let
-- a coat go under $40 means that on eBay and on Poshmark, and a per-listing
-- column would let the two disagree silently.
--
-- NULL IS NOT ZERO. A null floor means the seller has set none and every
-- existing behaviour stands unchanged; the composition rule is max(rule floor,
-- item floor) with nulls ignored, so a null can only ever widen what automation
-- may do, never narrow it. Storing 0 for "no floor" would have made the two
-- indistinguishable from a real floor of zero.
--
-- DEPLOY ORDER: database first. The edge SELECTs floor_price when it plans a
-- markdown or answers an offer, and the frontend reads it on the bulk-pricing
-- grid. The schema-version boot guard enforces it — EXPECTED_SCHEMA_VERSION
-- moves to 00769 in this same commit.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS floor_price decimal(10,2);

COMMENT ON COLUMN public.inventory_items.floor_price IS
  'Seller-set hard floor for this garment, in the listing currency. Every automated price change composes it as max(rule floor, this) with nulls ignored. NULL = no floor set, which is not the same as a floor of zero.';

-- A floor below zero is not a floor. Guarded rather than left to the callers,
-- because there are now four of them (markdown, offer rules, bulk reduce, the
-- composer) and one missed clamp would let automation price an item negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_floor_price_nonneg'
  ) THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT inventory_items_floor_price_nonneg
      CHECK (floor_price IS NULL OR floor_price >= 0);
  END IF;
END $$;

-- ── items_full gains the column, so the item grid and saved views can read it ──
--
-- CREATE OR REPLACE appending at the END, exactly as 00506 and 00650 did. A DROP
-- would fail against the analytics RPCs that select from this view, and
-- reordering columns would break every consumer that reads it with select("*").
-- Body otherwise VERBATIM from 00650, which is the current definition.

create or replace view public.items_full
with (security_invoker = on)
as
select
  i.id,
  i.user_id,
  i.sku                                                                  as item_number,
  i.container,
  i.title                                                                as item_title,
  i.description                                                          as item_description,
  i.brand,
  i.style,
  i.size,
  i.condition_notes                                                      as notes,
  i.comp_set                                                             as comps,
  coalesce(i.item_category::text, i.garment_category::text)              as category,
  s.name                                                                 as source_name,
  i.source_id,
  i.sourced_by,
  i.acquired_date                                                        as purchase_date,
  i.acquired_price                                                       as purchase_price,
  (l.id is not null)                                                     as listed,
  l.listed_at                                                            as list_date,
  coalesce(
    nullif(l.listing_url, ''),
    case
      when l.platform_listing_id is not null and l.platform_listing_id <> ''
        then 'https://www.ebay.com/itm/' || l.platform_listing_id
      else null
    end
  )                                                                      as link,
  l.listing_price                                                        as list_price,
  coalesce(sa.sold_at, sa.sale_date)                                     as sale_date,
  sa.sale_price                                                         as sale_price,
  coalesce(sa.platform_fees, 0) + coalesce(sa.payment_processing_fees, 0) as fees,
  sa.tax                                                                 as tax,
  sa.shipping_cost                                                       as shipping_cost,
  sa.net_profit                                                          as net_profit,
  sa.payout_amount                                                       as payout,
  i.status                                                               as status,
  case
    when l.listed_at is not null and coalesce(sa.sold_at, sa.sale_date) is not null
      then extract(day from (coalesce(sa.sold_at, sa.sale_date) - l.listed_at))::int
    else null
  end                                                                    as days_to_sell,
  sa.tracking_number                                                     as tracking,
  i.target_price,
  i.grade_value,
  i.grade_label,
  i.certificate_url,
  i.measurements,
  i.location_bin,
  i.created_at,
  i.updated_at,
  sa.buyer_id                                                            as buyer_id,
  sa.sold_at                                                             as sold_at_raw,
  sa.payout_reference                                                    as payout_reference,
  l.listing_status                                                       as listing_status,
  l.id                                                                   as listing_id,
  l.watchers                                                             as listing_watchers,
  l.views                                                                as listing_views,
  (
    select count(*)::int from public.item_photos p
    where p.inventory_item_id = i.id
  )                                                                      as photo_count,
  (
    select count(distinct p.photo_type) = 2
    from public.item_photos p
    where p.inventory_item_id = i.id
      and p.photo_type in ('front', 'back')
  )                                                                      as has_required_photos,
  i.ai_field_sources                                                     as ai_field_sources,
  i.ai_enriched_at                                                       as ai_enriched_at,
  sa.status                                                              as sale_status,
  sa.cancelled_at                                                        as sale_cancelled_at,
  i.color                                                                as color,
  l.platform                                                             as listing_platform,
  sa.carrier                                                             as carrier,
  sa.shipped_at                                                          as shipped_at,
  sa.delivered_at                                                        as delivered_at,
  l.needs_review                                                         as listing_needs_review,
  l.reviewed_at                                                          as listing_reviewed_at,
  l.listing_title                                                        as listing_title,
  -- US-2170: NEW last column — the persisted Listing Quality Score.
  l.quality_score                                                        as quality_score,
  -- US-2790: NEW last columns. The parcel estimator reads the garment TYPE and
  -- the fabric; neither was exposed here, and `category` above is a coalesce of
  -- item_category and garment_category, so it is not a substitute — feeding it
  -- to the estimator would pass a merchandising category where a garment type
  -- belongs, fall through to the `other` base weight, and still report the
  -- number as category-derived.
  i.garment_category                                                     as garment_category,
  i.material                                                             as material,
  -- US-3192: NEW last column — the seller's hard floor on this garment, so a
  -- saved view can find items sitting at or near it. Appended at the END and
  -- every existing column keeps its name, order and type, so the analytics RPCs
  -- that select from this view are unaffected.
  i.floor_price                                                          as floor_price
from public.inventory_items i
left join public.sources s on s.id = i.source_id
left join lateral (
  select * from public.listings
  where listings.inventory_item_id = i.id
  order by listings.listed_at desc nulls last, listings.created_at desc
  limit 1
) l on true
left join lateral (
  select * from public.sales
  where sales.inventory_item_id = i.id
  order by coalesce(sales.sold_at, sales.sale_date) desc nulls last,
    sales.created_at desc
  limit 1
) sa on true;

insert into public.applied_migrations (version) values ('00769') on conflict do nothing;
