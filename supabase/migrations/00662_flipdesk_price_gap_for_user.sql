-- US-2828: let the weekly digest ask this question on a seller's behalf.
--
-- flipdesk_price_gap scored the CALLER's items by reading the ambient identity
-- in three places. That is correct for the browser and useless to the edge: the
-- edge holds the service-role client, auth.uid() is NULL there, and every
-- scoped CTE returned an empty set. Not an error - a 200 with nothing in it,
-- for every seller. US-2829 AC2 and US-2828 AC1 were both blocked on exactly
-- this, and src/test/edge-never-calls-caller-scoped-rpc.test.ts holds the
-- edge-caller count at zero so nobody wires one up by accident.
--
-- WHY A PARAMETER RATHER THAN THE THREE ALTERNATIVES. Calling it as-is returns
-- an empty digest for everyone, silently. Reimplementing the scoring on the
-- edge makes a THIRD copy of analytics math; the web already owns one, and one
-- unnoticed web/edge mirror cost a session earlier this month (US-2796).
-- Reading the base tables directly is the same thing with the maths hidden in
-- a query. The wrapper is the only option that does not duplicate the scoring.
--
-- THE SAFETY PROPERTY, and it is why p_user_id is ignored rather than refused:
-- for any caller that is not service_role the parameter has no effect at all.
-- A logged-in seller who passes another seller's id gets their own rows back.
-- There is no error to probe, so the argument cannot be used as an oracle
-- either. service_role passing nothing behaves exactly as today.
--
-- DROP THEN CREATE OR REPLACE, and both halves are load-bearing (US-2837).
-- Adding a defaulted parameter creates a SECOND overload rather than replacing
-- the first, and PostgREST would then find two candidates for a one-argument
-- call and fail it as ambiguous, so the old (date) signature has to go. The
-- create still says OR REPLACE so this file survives a second run.
--
-- AND THE DROP IS WHY THE GRANTS ARE RE-ISSUED BELOW. Dropping a function
-- destroys its grants; the fresh create hands EXECUTE back to PUBLIC by the
-- CREATE default and nothing else. Measured on the local stack:
--   after CREATE OR REPLACE -> a prior REVOKE survives
--   after DROP + CREATE     -> it is gone
-- 00652's two grants are therefore restored explicitly. No REVOKE anywhere in
-- this file: a denied call from anon or authenticated segfaults this Postgres
-- image (US-2403), and gt_require_role in the body is what replaces it.
--
-- The scoring body is otherwise UNCHANGED from 00652. It was transformed
-- programmatically and the script asserts the round trip - undo the three
-- predicate rewrites and the signature, and the result is byte-identical to
-- 00652 - because a retype of a money query is how 00134's repair lost an
-- ON DELETE clause.

BEGIN;

DROP FUNCTION IF EXISTS public.flipdesk_price_gap(date);

create or replace function public.flipdesk_price_gap(
  p_period_start date default null,
  p_user_id     uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  SELECT CASE WHEN public.gt_require_role('flipdesk_price_gap', 'authenticated')
    THEN (
  with caller as (
    -- US-2828: whose figures these are.
    --
    -- The edge calls this with the service-role client, where the ambient
    -- identity is NULL, so the three scoped CTEs below returned NOTHING for
    -- every seller - silently, with a 200. That is the failure direction
    -- edge-never-calls-caller-scoped-rpc.test.ts exists to describe.
    --
    -- p_user_id is honoured ONLY for service_role. A logged-in caller who
    -- passes someone else's id gets their OWN rows back: the parameter is not
    -- rejected, it is ignored, so there is no oracle in the error either.
    -- service_role passing nothing keeps today's behaviour exactly.
    select case
      when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid())
      else auth.uid()
    end as uid
  ),
  cfg as (
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
    from realized where user_id = (select uid from caller) group by grade, brand
  ),
  own_category as (
    select grade, category,
      percentile_cont(0.5) within group (order by sale_price) as med,
      count(*)::int as n
    from realized where user_id = (select uid from caller) group by grade, category
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
    where b.user_id = (select uid from caller)
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

-- Restored from 00652. The DROP above took the originals with the old
-- signature, and these name the new one.
grant execute on function public.flipdesk_price_gap(date, uuid) to authenticated;
grant execute on function public.flipdesk_price_gap(date, uuid) to service_role;

insert into public.applied_migrations (version) values ('00662') on conflict do nothing;

COMMIT;
