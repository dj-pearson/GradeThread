-- US-2822: the Seller Scorecard.
--
-- Five numbers and a rank against comparable sellers, so a seller can find the
-- one thing worth fixing without reading five tabs.
--
-- THE COHORT IS ONE VALUE PER SELLER, not one value per item. A percentile over
-- items would rank a seller with 400 listings against a distribution their own
-- inventory largely IS, and would report that as an external comparison. Each
-- seller contributes exactly one number to each metric's distribution.
--
-- AN ACTIVITY FLOOR, SEPARATE FROM THE PRIVACY FLOOR. A seller with two sales
-- has a 100% or a 0% sell-through, and a cohort full of those is noise wearing a
-- percentile. min_activity keeps them out of the DISTRIBUTION. It does not keep
-- them out of their own scorecard: their own value is their own data and is
-- always returned, with a null percentile.
--
-- DIRECTION IS DATA, NOT PRESENTATION. days-to-sell and return rate are better
-- when lower, so the percentile is computed against the direction and 100 always
-- means best. A client that had to know which way each metric ran would get one
-- of them wrong eventually.
--
-- Guarded with gt_require_role (00640), not a REVOKE (US-2403).

BEGIN;

create or replace function public.seller_scorecard(
  p_period_start date default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  SELECT CASE WHEN public.gt_require_role('seller_scorecard', 'authenticated')
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
      -- Items (or sales) a seller needs before they join a distribution.
      5::int as min_activity
  ),
  base as (
    select
      i.user_id,
      i.grade_value,
      i.acquired_date,
      l.list_date,
      l.list_price,
      sa.sale_date,
      sa.sale_price,
      sa.status as sale_status
    from public.inventory_items i
    left join lateral (
      select listed_at as list_date, listing_price as list_price
      from public.listings
      where listings.inventory_item_id = i.id
      order by listings.listed_at desc nulls last, listings.created_at desc
      limit 1
    ) l on true
    left join lateral (
      select
        coalesce(s.sold_at, s.sale_date) as sale_date,
        s.sale_price,
        s.status
      from public.sales s
      where s.inventory_item_id = i.id
      order by coalesce(s.sold_at, s.sale_date) desc nulls last, s.created_at desc
      limit 1
    ) sa on true
  ),
  win as (
    select
      *,
      (list_date is not null
        and (p_period_start is null or list_date::date >= p_period_start)) as listed_hit,
      (sale_date is not null and sale_status = 'completed'
        and (p_period_start is null or sale_date::date >= p_period_start)) as sold_hit,
      -- "Fulfilled" is exactly what flipdesk_return_reduction (00168) means by
      -- it: a sale that shipped, which it reads off the status rather than off
      -- the shipments table. Cancelled and pending orders never shipped, so
      -- they cannot come back and are not in the denominator. Checked against
      -- that function rather than assumed, because a return rate on a different
      -- denominator would silently disagree with the Returns tab.
      (sale_date is not null
        and sale_status in ('completed', 'refunded')
        and (p_period_start is null or sale_date::date >= p_period_start)) as fulfilled_hit,
      (sale_date is not null and sale_status = 'refunded'
        and (p_period_start is null or sale_date::date >= p_period_start)) as refunded_hit,
      (acquired_date is not null
        and (p_period_start is null or acquired_date::date >= p_period_start)) as sourced_hit
    from base
  ),
  -- ONE ROW PER SELLER PER METRIC. Every metric below produces (metric,
  -- user_id, value, n) so the ranking runs once instead of five times.
  seller_metrics as (
    select 'sell_through' as metric, user_id,
      count(*) filter (where sold_hit)::numeric
        / nullif(count(*) filter (where listed_hit), 0) as value,
      count(*) filter (where listed_hit)::int as n
    from win group by user_id

    union all
    select 'price_realization', user_id,
      percentile_cont(0.5) within group (
        order by case when sold_hit and list_price > 0 then sale_price / list_price end
      ),
      count(*) filter (where sold_hit and list_price > 0)::int
    from win group by user_id

    union all
    select 'days_to_sell', user_id,
      percentile_cont(0.5) within group (
        order by case
          when sold_hit and list_date is not null and sale_date::date >= list_date::date
          then (sale_date::date - list_date::date) end
      ),
      count(*) filter (where sold_hit and list_date is not null)::int
    from win group by user_id

    union all
    select 'return_rate', user_id,
      count(*) filter (where refunded_hit)::numeric
        / nullif(count(*) filter (where fulfilled_hit), 0),
      count(*) filter (where fulfilled_hit)::int
    from win group by user_id

    union all
    select 'grade_yield', user_id,
      percentile_cont(0.5) within group (
        order by case when sourced_hit then grade_value end
      ),
      count(*) filter (where sourced_hit and grade_value is not null)::int
    from win group by user_id
  ),
  -- The distribution: only sellers past the activity floor, and only where the
  -- metric produced a number at all.
  pool as (
    select sm.metric, sm.user_id, sm.value
    from seller_metrics sm, cfg c
    where sm.value is not null and sm.n >= c.min_activity
  ),
  dist as (
    select
      metric,
      count(*)::int as sellers,
      percentile_cont(0.25) within group (order by value) as p25,
      percentile_cont(0.50) within group (order by value) as p50,
      percentile_cont(0.75) within group (order by value) as p75
    from pool group by metric
  ),
  mine as (
    select metric, value, n from seller_metrics where user_id = auth.uid()
  ),
  -- Direction lives here so both the percentile and the payload agree on it.
  dirs(metric, direction, ord) as (
    values
      ('sell_through',      'higher_is_better', 1),
      ('price_realization', 'higher_is_better', 2),
      ('days_to_sell',      'lower_is_better',  3),
      ('return_rate',       'lower_is_better',  4),
      ('grade_yield',       'higher_is_better', 5)
  ),
  scored as (
    select
      d.metric,
      d.direction,
      d.ord,
      m.value as own_value,
      coalesce(m.n, 0) as own_n,
      coalesce(di.sellers, 0) as sellers,
      di.p25, di.p50, di.p75,
      case
        when m.value is null then null
        when coalesce(di.sellers, 0) < c.min_sellers then null
        else round(
          100.0 * (
            select count(*)::numeric
            from pool p
            where p.metric = d.metric
              and case when d.direction = 'higher_is_better'
                    then p.value <= m.value
                    else p.value >= m.value end
          ) / nullif(di.sellers, 0),
          0
        )
      end as percentile
    from dirs d
    cross join cfg c
    left join mine m on m.metric = d.metric
    left join dist di on di.metric = d.metric
  )
  select jsonb_build_object(
    'periodStart', p_period_start,
    'minSellers', (select min_sellers from cfg),
    'minActivity', (select min_activity from cfg),
    'metrics', coalesce((
      select jsonb_agg(jsonb_build_object(
        'metric', metric,
        'direction', direction,
        'ownValue', case when own_value is null then null
          else round(own_value::numeric, 4) end,
        'ownSampleSize', own_n,
        'cohortSellers', sellers,
        'cohortP25', case when sellers >= (select min_sellers from cfg)
          then round(p25::numeric, 4) end,
        'cohortMedian', case when sellers >= (select min_sellers from cfg)
          then round(p50::numeric, 4) end,
        'cohortP75', case when sellers >= (select min_sellers from cfg)
          then round(p75::numeric, 4) end,
        'ownPercentile', case when percentile is null then null
          else percentile::int end
      ) order by ord)
      from scored
    ), '[]'::jsonb)
  )
  ) END;
$$;

grant execute on function public.seller_scorecard(date) to authenticated;
grant execute on function public.seller_scorecard(date) to service_role;

insert into public.applied_migrations (version) values ('00654') on conflict do nothing;

COMMIT;
