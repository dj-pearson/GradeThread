-- US-2170: expose listings.quality_score (00476) on the items_full reporting
-- view so the inventory table can SORT by the Listing Quality Score without a
-- second per-row read. The page-scoped quality fetch (listings.tsx) stays for the
-- chip's blocked state; sorting needs the score ON the row so the client sort
-- (which orders the full filtered set before paginating) can order by it.
--
-- CREATE OR REPLACE VIEW appends quality_score as a new LAST column, so all
-- existing columns keep their name/order/type (dependents like the analytics RPCs
-- that SELECT from items_full are unaffected). Body is otherwise verbatim from
-- 00438 (the current definition). No DROP — that would fail against dependents.

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
  l.quality_score                                                        as quality_score
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

insert into public.applied_migrations (version) values ('00506') on conflict do nothing;
