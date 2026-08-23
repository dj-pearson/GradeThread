-- US-2819: the Condition Price Curve.
--
-- What a half grade point is worth, in dollars and in days, for a brand or a
-- category. Every other grade analysis in this codebase stops at grade_tier,
-- which is 7 buckets. The scale is 1.0-10.0 and the curve wants all 19 half
-- steps, because the pricing question is "8.5 or 8.0", never "Excellent or
-- Very Good".
--
-- TWO SIDES, ONE DOCUMENT. The caller's own realized sales at any sample size
-- (that is their data), and the cross-seller cohort behind the same
-- k-anonymity floor community_benchmarks() reads from system_settings, hard
-- clamped with greatest(5, ...) so a misconfiguration can only raise it.
--
-- THE COHORT INCLUDES THE CALLER, unlike the peerComparison in 00241. That one
-- answers "how do I rank", so it must exclude you. This one answers "what does
-- this garment sell for", and dropping your own sales makes the estimate worse
-- for exactly the sellers who have the most evidence. The floor still applies
-- to DISTINCT sellers, so no bucket is ever a report on one person.
--
-- SUPPRESSION IS VISIBLE. A bucket under the floor still reports cohortCount
-- and cohortSellers and sets cohortSuppressed, with every price and day figure
-- null. A dropped bucket reads as "no market"; a suppressed one reads as "not
-- enough sellers", and those are different answers.
--
-- Only sales with status = 'completed' count (00111). Days-to-sell needs a
-- list date at or before the sale.
--
-- Guarded with gt_require_role (00640), not a REVOKE: a denied call segfaults
-- this Postgres image (US-2403).

BEGIN;

-- The cross-seller scan reads only graded items. Most inventory is ungraded,
-- so the partial index is the difference between a scan of the table and a scan
-- of the population this function is about.
create index if not exists idx_inventory_items_grade_value
  on public.inventory_items(grade_value)
  where grade_value is not null;

create or replace function public.condition_price_curve(
  -- Case-insensitive exact matches on the SAME normalized expressions the
  -- buckets group by, so "carhartt" selects the cohort the "Carhartt" row
  -- describes. Both null = every graded item.
  p_brand text default null,
  p_category text default null,
  -- Windows the SALE, not the listing: the curve is about realized prices.
  p_period_start date default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  SELECT CASE WHEN public.gt_require_role('condition_price_curve', 'authenticated')
    THEN (
  with cfg as (
    select greatest(
      5,
      coalesce(
        (select nullif(value #>> '{}', '')::int
           from public.system_settings
          where key = 'community_min_cohort_sellers'),
        5
      )
    )::int as min_sellers
  ),
  -- One row per graded inventory item, platform-wide, with its latest listing
  -- and its latest COMPLETED sale. Same lateral shape as community_benchmarks
  -- (00241) so the two agree about what "listed" and "sold" mean.
  base as (
    select
      i.user_id,
      -- Bucket to the nearest half point. grade_value is decimal(3,1), so this
      -- is the only place 19 buckets get made out of 91 possible values.
      (round(i.grade_value * 2) / 2.0)::numeric(3,1) as grade,
      coalesce(nullif(trim(i.brand), ''), 'No brand') as brand,
      coalesce(
        nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
        'Uncategorized'
      ) as category,
      l.list_date,
      sa.sale_date,
      sa.sale_price
    from public.inventory_items i
    left join lateral (
      select listed_at as list_date
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
  -- Realized sales inside the window, with days-to-sell derived once.
  sold as (
    select
      user_id,
      grade,
      brand,
      category,
      sale_price,
      case
        when list_date is not null and sale_date::date >= list_date::date
        then (sale_date::date - list_date::date)
      end as days_to_sell
    from base
    where sale_date is not null
      and sale_price is not null
      and (p_period_start is null or sale_date::date >= p_period_start)
  ),
  -- The filtered population both sides read. A null filter matches everything;
  -- a supplied one is a case-insensitive exact match.
  scoped as (
    select *
    from sold
    where (p_brand is null or lower(brand) = lower(trim(p_brand)))
      and (p_category is null or lower(category) = lower(trim(p_category)))
  ),
  grades as (
    select (n / 2.0)::numeric(3,1) as grade
    from generate_series(2, 20) as n
  ),
  own_stats as (
    select
      grade,
      count(*)::int as n,
      percentile_cont(0.5) within group (order by sale_price) as median_price,
      count(days_to_sell) as n_days,
      percentile_cont(0.5) within group (order by days_to_sell) as median_days
    from scoped
    where user_id = auth.uid()
    group by grade
  ),
  cohort_stats as (
    select
      grade,
      count(*)::int as n,
      count(distinct user_id)::int as sellers,
      percentile_cont(0.5) within group (order by sale_price) as median_price,
      percentile_cont(0.25) within group (order by sale_price) as p25_price,
      percentile_cont(0.75) within group (order by sale_price) as p75_price,
      count(days_to_sell) as n_days,
      percentile_cont(0.5) within group (order by days_to_sell) as median_days
    from scoped
    group by grade
  )
  select jsonb_build_object(
    'brand', p_brand,
    'category', p_category,
    'periodStart', p_period_start,
    'minSellers', (select min_sellers from cfg),
    'ownTotal', (select count(*)::int from scoped where user_id = auth.uid()),
    'cohortTotal', (select count(*)::int from scoped),
    'cohortSellersTotal', (select count(distinct user_id)::int from scoped),
    'buckets', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'grade', g.grade,
          'ownCount', coalesce(o.n, 0),
          'ownMedianPrice', case when o.n > 0 then round(o.median_price::numeric, 2) end,
          'ownMedianDays', case when o.n_days > 0 then round(o.median_days::numeric, 1) end,
          'cohortCount', coalesce(c.n, 0),
          'cohortSellers', coalesce(c.sellers, 0),
          'cohortSuppressed', coalesce(c.sellers, 0) < (select min_sellers from cfg),
          -- Every cohort MEASURE below is null unless the seller floor is met.
          -- The counts above are deliberately outside that gate: they say why
          -- the measures are missing, and a count of sellers is not a report on
          -- any of them.
          'cohortMedianPrice', case
            when coalesce(c.sellers, 0) >= (select min_sellers from cfg)
            then round(c.median_price::numeric, 2) end,
          'cohortP25Price', case
            when coalesce(c.sellers, 0) >= (select min_sellers from cfg)
            then round(c.p25_price::numeric, 2) end,
          'cohortP75Price', case
            when coalesce(c.sellers, 0) >= (select min_sellers from cfg)
            then round(c.p75_price::numeric, 2) end,
          'cohortMedianDays', case
            when coalesce(c.sellers, 0) >= (select min_sellers from cfg)
              and c.n_days > 0
            then round(c.median_days::numeric, 1) end
        )
        order by g.grade
      )
      from grades g
      left join own_stats o on o.grade = g.grade
      left join cohort_stats c on c.grade = g.grade
    ), '[]'::jsonb)
  )
  ) END;
$$;

-- Called from the browser by a signed-in seller. service_role for the edge and
-- for any future server-side reader. No REVOKE, on purpose: see the header.
grant execute on function public.condition_price_curve(text, text, date) to authenticated;
grant execute on function public.condition_price_curve(text, text, date) to service_role;

insert into public.applied_migrations (version) values ('00651') on conflict do nothing;

COMMIT;
