-- US-2826: does listing work actually move the numbers?
--
-- listing_metrics (00159) has kept a per-day impressions / views / watchers /
-- CTR history since the 6-hourly traffic sync started writing it, and nothing
-- has ever read it against WHAT THE LISTING LOOKED LIKE. This does: photo
-- count, Listing Quality Score, and whether the item carried a grade.
--
-- ── ASSOCIATION, AND THE SQL SAYS SO BECAUSE THE UI HAS TO ─────────────────
-- Nothing here is a causal claim and none of it can be. Sellers who take nine
-- photos are not a random sample of sellers; they are the ones who care, and
-- they do six other things differently too. The report answers "listings that
-- look like X get Y", which is worth knowing and is not "adding photos causes
-- Y". Every copy string on the surface is written to that limit.
--
-- CONTROLLED WITHIN CATEGORY. Outerwear gets more watchers than tees at any
-- photo count, so an uncontrolled rollup mostly measures what a seller happens
-- to sell. Buckets are reported per category; the all-category rollup is
-- returned too and is LABELLED uncontrolled rather than being the headline.
--
-- THE FIRST 14 DAYS ONLY, and at least 7 of them present. A listing live for
-- three days has not had its impressions yet, and one live for a year would
-- otherwise drown a fresh one purely by having accumulated longer. Listings
-- with fewer than 7 metric rows are excluded and the count is reported.
--
-- SECURITY INVOKER: listing_metrics is RLS'd to its owner and items_full is
-- security_invoker, so this is the caller's own data throughout. No cohort, no
-- k-anonymity question.

BEGIN;

create or replace function public.flipdesk_listing_quality_lift(
  p_period_start date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with cfg as (
    select
      14::int as window_days,
      7::int  as min_days,
      -- A bucket needs this many listings before its medians are quoted.
      5::int  as min_listings
  ),
  -- One row per listing, with its first-14-days traffic and the three things
  -- about how it was built.
  listing_window as (
    select
      l.id as listing_id,
      i.id as item_id,
      coalesce(
        nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
        'Uncategorized'
      ) as category,
      l.quality_score,
      (i.grade_value is not null) as is_graded,
      (select count(*)::int from public.item_photos p
        where p.inventory_item_id = i.id) as photo_count,
      m.days, m.impressions, m.views, m.watchers, m.ctr
    from public.listings l
    join public.inventory_items i on i.id = l.inventory_item_id
    join lateral (
      select
        count(*)::int as days,
        sum(lm.impressions)::bigint as impressions,
        sum(lm.views)::bigint as views,
        max(lm.watchers)::int as watchers,
        avg(lm.click_through_rate) as ctr
      from public.listing_metrics lm, cfg c
      where lm.listing_id = l.id
        and lm.metric_date >= l.listed_at::date
        and lm.metric_date < l.listed_at::date + c.window_days
    ) m on true
    cross join cfg c2
    where l.listed_at is not null
      and (p_period_start is null or l.listed_at::date >= p_period_start)
      and m.days >= c2.min_days
  ),
  -- One row per listing per DIMENSION, so three near-identical aggregations
  -- become one. `dim` names the axis, `bucket` names the step on it.
  binned as (
    select
      lw.category, lw.impressions, lw.views, lw.watchers, lw.ctr,
      d.dim, d.bucket, d.ord
    from listing_window lw
    cross join lateral (values
      ('photos',
       case
         when lw.photo_count <= 3 then '1 to 3'
         when lw.photo_count <= 7 then '4 to 7'
         else '8 or more'
       end,
       case when lw.photo_count <= 3 then 1 when lw.photo_count <= 7 then 2 else 3 end),
      ('quality',
       case
         when lw.quality_score is null then 'No score'
         when lw.quality_score < 60 then 'Under 60'
         when lw.quality_score < 80 then '60 to 79'
         else '80 or more'
       end,
       case
         when lw.quality_score is null then 4
         when lw.quality_score < 60 then 1
         when lw.quality_score < 80 then 2
         else 3 end),
      ('graded',
       case when lw.is_graded then 'Graded' else 'Ungraded' end,
       case when lw.is_graded then 1 else 2 end)
    ) as d(dim, bucket, ord)
  ),
  by_category as (
    select category, dim, bucket, min(ord) as ord,
      count(*)::int as listings,
      percentile_cont(0.5) within group (order by impressions) as med_impressions,
      percentile_cont(0.5) within group (order by views) as med_views,
      percentile_cont(0.5) within group (order by watchers) as med_watchers,
      percentile_cont(0.5) within group (order by ctr) as med_ctr
    from binned group by category, dim, bucket
  ),
  overall as (
    select dim, bucket, min(ord) as ord,
      count(*)::int as listings,
      percentile_cont(0.5) within group (order by impressions) as med_impressions,
      percentile_cont(0.5) within group (order by views) as med_views,
      percentile_cont(0.5) within group (order by watchers) as med_watchers,
      percentile_cont(0.5) within group (order by ctr) as med_ctr
    from binned group by dim, bucket
  )
  select jsonb_build_object(
    'periodStart', p_period_start,
    'windowDays', (select window_days from cfg),
    'minDays', (select min_days from cfg),
    'minListings', (select min_listings from cfg),
    'listingsIncluded', (select count(*)::int from listing_window),
    'listingsExcluded', (
      -- Live but not yet 7 days of metrics, or never synced at all.
      select count(*)::int
      from public.listings l
      where l.listed_at is not null
        and (p_period_start is null or l.listed_at::date >= p_period_start)
        and l.id not in (select listing_id from listing_window)
    ),
    'byCategory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category', bc.category, 'dimension', bc.dim, 'bucket', bc.bucket,
        'listings', bc.listings,
        'medianImpressions', case when bc.listings >= c.min_listings
          then round(bc.med_impressions::numeric, 0) end,
        'medianViews', case when bc.listings >= c.min_listings
          then round(bc.med_views::numeric, 0) end,
        'medianWatchers', case when bc.listings >= c.min_listings
          then round(bc.med_watchers::numeric, 1) end,
        'medianCtr', case when bc.listings >= c.min_listings
          then round(bc.med_ctr::numeric, 4) end
      ) order by bc.category, bc.dim, bc.ord)
      from by_category bc cross join cfg c
    ), '[]'::jsonb),
    -- Labelled uncontrolled in the payload itself, so a client cannot show it
    -- as the headline without printing the word.
    'uncontrolled', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dimension', o.dim, 'bucket', o.bucket, 'listings', o.listings,
        'medianImpressions', case when o.listings >= c.min_listings
          then round(o.med_impressions::numeric, 0) end,
        'medianViews', case when o.listings >= c.min_listings
          then round(o.med_views::numeric, 0) end,
        'medianWatchers', case when o.listings >= c.min_listings
          then round(o.med_watchers::numeric, 1) end,
        'medianCtr', case when o.listings >= c.min_listings
          then round(o.med_ctr::numeric, 4) end
      ) order by o.dim, o.ord)
      from overall o cross join cfg c
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.flipdesk_listing_quality_lift(date) to authenticated;
grant execute on function public.flipdesk_listing_quality_lift(date) to service_role;

insert into public.applied_migrations (version) values ('00657') on conflict do nothing;

COMMIT;
