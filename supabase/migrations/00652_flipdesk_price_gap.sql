-- US-2820: Money Left On The Table.
--
-- Every graded item the caller sold, scored against what the Condition Price
-- Curve (00651) says that grade clears. The shortfall is summed into one
-- number, the ten worst are named, and live listings priced under their grade
-- are flagged before they become another one.
--
-- THE PREDICTION DOES NOT COME FROM repricing_suggestions.comp_median_cents,
-- which is the obvious source and is wrong for this. US-2280 established that
-- that column holds the CURRENT suggestion for a listing rather than a snapshot
-- taken at grade time: a row applied, dismissed or rescanned after the sale
-- carries a comp from a different moment than the sale it would be compared
-- against. Usable across many items, not usable to characterise one, and this
-- report names individual items.
--
-- THE CURVE IS ALL-TIME EVEN WHEN THE SCORED SALES ARE WINDOWED. A 30-day
-- window would price a 30-day window's worth of sales against a 30-day window's
-- worth of evidence, which is the thinnest possible version of both. The cost
-- is that price drift is not modelled; the report says "against your realized
-- curve", never "against market value today".
--
-- A GAP IS NEVER NEGATIVE. Selling above the curve contributes zero rather than
-- offsetting somebody else's shortfall: the figure answers "what did I leave",
-- not "how did I do on average", and a net number would hide ten bad sales
-- behind one good one.
--
-- FOUR BASES, IN ORDER: cohort brand, cohort category, own brand, own category.
-- Cohort buckets must clear the k-anonymity floor AND the sample floor; own
-- buckets need only the sample floor, because they are the caller's own data.
-- An item matching none of the four is UNSCORED and counted as such.
--
-- Guarded with gt_require_role (00640), not a REVOKE (US-2403).

BEGIN;

create or replace function public.flipdesk_price_gap(
  p_period_start date default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  SELECT CASE WHEN public.gt_require_role('flipdesk_price_gap', 'authenticated')
    THEN (
  with cfg as (
    select
      greatest(
        5,
        coalesce(
          (select nullif(value #>> '{}', '')::int
             from public.system_settings
            where key = 'community_min_cohort_sellers'),
          5
        )
      )::int as min_sellers,
      -- Mirrors MIN_CURVE_SAMPLE in src/lib/condition-price-curve.ts. Below it
      -- a bucket median is one seller's week, not a price.
      5::int as min_sample
  ),
  -- Platform-wide graded items with their latest listing and latest COMPLETED
  -- sale. Same lateral shape as 00651 so both agree on what "sold" means.
  base as (
    select
      i.id,
      i.user_id,
      i.title,
      i.status,
      (round(i.grade_value * 2) / 2.0)::numeric(3,1) as grade,
      coalesce(nullif(trim(i.brand), ''), 'No brand') as brand,
      coalesce(
        nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
        'Uncategorized'
      ) as category,
      l.list_price,
      sa.sale_date,
      sa.sale_price
    from public.inventory_items i
    left join lateral (
      select listing_price as list_price
      from public.listings
      where listings.inventory_item_id = i.id
      order by listings.listed_at desc nulls last, listings.created_at desc
      limit 1
    ) l on true
    left join lateral (
      select coalesce(sold_at, sale_date) as sale_date, sale_price
      from public.sales
      where sales.inventory_item_id = i.id
        and sales.status = 'completed'
      order by coalesce(sales.sold_at, sales.sale_date) desc nulls last,
        sales.created_at desc
      limit 1
    ) sa on true
    where i.grade_value is not null
      and i.grade_value >= 1.0
      and i.grade_value <= 10.0
  ),
  -- Every realized sale on the platform, all-time. This is the curve's input.
  realized as (
    select user_id, grade, brand, category, sale_price
    from base
    where sale_date is not null and sale_price is not null
  ),
  cohort_brand as (
    select grade, brand,
      percentile_cont(0.5) within group (order by sale_price) as med,
      count(*)::int as n, count(distinct user_id)::int as sellers
    from realized group by grade, brand
  ),
  cohort_category as (
    select grade, category,
      percentile_cont(0.5) within group (order by sale_price) as med,
      count(*)::int as n, count(distinct user_id)::int as sellers
    from realized group by grade, category
  ),
  own_brand as (
    select grade, brand,
      percentile_cont(0.5) within group (order by sale_price) as med,
      count(*)::int as n
    from realized where user_id = auth.uid() group by grade, brand
  ),
  own_category as (
    select grade, category,
      percentile_cont(0.5) within group (order by sale_price) as med,
      count(*)::int as n
    from realized where user_id = auth.uid() group by grade, category
  ),
  -- The caller's own items, each carrying whichever basis it qualified for.
  -- Written once and reused for both the sold scoring and the live flags.
  mine as (
    select
      b.*,
      case
        when cb.sellers >= c.min_sellers and cb.n >= c.min_sample then 'cohort_brand'
        when cc.sellers >= c.min_sellers and cc.n >= c.min_sample then 'cohort_category'
        when ob.n >= c.min_sample then 'own_brand'
        when oc.n >= c.min_sample then 'own_category'
      end as basis,
      case
        when cb.sellers >= c.min_sellers and cb.n >= c.min_sample then cb.med
        when cc.sellers >= c.min_sellers and cc.n >= c.min_sample then cc.med
        when ob.n >= c.min_sample then ob.med
        when oc.n >= c.min_sample then oc.med
      end as curve_median
    from base b
    cross join cfg c
    left join cohort_brand cb on cb.grade = b.grade and cb.brand = b.brand
    left join cohort_category cc on cc.grade = b.grade and cc.category = b.category
    left join own_brand ob on ob.grade = b.grade and ob.brand = b.brand
    left join own_category oc on oc.grade = b.grade and oc.category = b.category
    where b.user_id = auth.uid()
  ),
  -- Sold, in the window, with the shortfall floored at zero.
  scored_sales as (
    select
      id, title, brand, grade, basis, sale_date,
      sale_price,
      round(curve_median::numeric, 2) as curve_median,
      greatest(round((curve_median - sale_price)::numeric, 2), 0) as gap
    from mine
    where sale_date is not null
      and sale_price is not null
      and curve_median is not null
      and (p_period_start is null or sale_date::date >= p_period_start)
  ),
  unscored_sales as (
    select count(*)::int as n
    from mine
    where sale_date is not null
      and sale_price is not null
      and curve_median is null
      and (p_period_start is null or sale_date::date >= p_period_start)
  ),
  -- Still listed, never sold, and asking less than the grade clears. The
  -- window does not apply: "what is underpriced right now" has no past tense.
  live_gaps as (
    select
      id, title, brand, grade, basis,
      list_price,
      round(curve_median::numeric, 2) as curve_median,
      round((curve_median - list_price)::numeric, 2) as gap
    from mine
    where sale_date is null
      and status = 'listed'
      and list_price is not null
      and curve_median is not null
      and list_price < curve_median
  )
  select jsonb_build_object(
    'periodStart', p_period_start,
    'minSellers', (select min_sellers from cfg),
    'minSample', (select min_sample from cfg),
    'itemsScored', (select count(*)::int from scored_sales),
    'itemsUnscored', (select n from unscored_sales),
    'totalGapDollars', coalesce((select round(sum(gap)::numeric, 2) from scored_sales), 0),
    'liveScored', (select count(*)::int from live_gaps),
    'liveGapDollars', coalesce((select round(sum(gap)::numeric, 2) from live_gaps), 0),
    'worst', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'title', title, 'brand', brand, 'grade', grade,
        'salePrice', round(sale_price::numeric, 2), 'curveMedian', curve_median,
        'gapDollars', gap, 'basis', basis, 'saleDate', sale_date
      ) order by gap desc, id)
      from (select * from scored_sales where gap > 0 order by gap desc, id limit 10) w
    ), '[]'::jsonb),
    'live', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'title', title, 'brand', brand, 'grade', grade,
        'listPrice', round(list_price::numeric, 2), 'curveMedian', curve_median,
        'gapDollars', gap, 'basis', basis
      ) order by gap desc, id)
      from (select * from live_gaps order by gap desc, id limit 25) v
    ), '[]'::jsonb)
  )
  ) END;
$$;

grant execute on function public.flipdesk_price_gap(date) to authenticated;
grant execute on function public.flipdesk_price_gap(date) to service_role;

insert into public.applied_migrations (version) values ('00652') on conflict do nothing;

COMMIT;
