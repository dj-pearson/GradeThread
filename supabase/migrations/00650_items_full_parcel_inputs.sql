-- US-2790: expose garment_category and material on items_full so the parcel
-- estimator can read them.
--
-- WHY THE VIEW AND NOT THE TYPE. src/types/database.ts's ItemFullRow is the
-- shape of THIS view, fetched with select("*"), and six composer components
-- consume it. Adding the two fields to the TypeScript type alone would declare
-- columns the query never returns - a type that is present at compile time and
-- undefined at runtime, which is worse than the omission it replaces.
--
-- `category` IS NOT A SUBSTITUTE, and this is the trap worth naming. It is
-- coalesce(item_category, garment_category): item_category when one is set,
-- garment_category otherwise. Passing it to estimateParcel would hand a
-- merchandising category to a function expecting a garment type, which falls
-- through to the `other` base weight AND still reports basis ["category"] - a
-- confident-looking number from a wrong input, which is the exact failure the
-- design warns about.
--
-- CREATE OR REPLACE, appending at the END, exactly as 00506 and 00438 did. All
-- existing columns keep their name, order and type, so dependents (the
-- analytics RPCs that select from items_full) are unaffected. No DROP - that
-- would fail against those dependents.
--
-- Body otherwise VERBATIM from 00506, which is the current definition.

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
  i.material                                                             as material
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

insert into public.applied_migrations (version) values ('00650') on conflict do nothing;
