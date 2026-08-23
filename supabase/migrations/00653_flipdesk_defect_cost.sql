-- US-2821: the Defect Cost Ledger.
--
-- What each kind of flaw costs, in realized price and in days, priced from
-- grade_reports.defects_found (00058) against sales that actually happened.
--
-- ── THE THING A READER WILL GET WRONG, so it is here and not in a note ──────
-- The defect ALREADY lowered the grade. Comparing a defective item to the whole
-- market would therefore measure the grade twice and report nothing new. Every
-- ratio below is against the median price of the item's OWN (grade, category)
-- band, so the question it answers is the one worth asking: among items the
-- grader scored the SAME, does this flaw still predict a lower price? "A 7.0
-- with pilling clears 11% less than a 7.0 without" is a fact about disclosure
-- and buyer reaction, not about grading.
--
-- RATIOS, NOT DOLLARS. A dollar average would rank defects by how expensive the
-- garments carrying them happen to be. Scaling every price in the input by any
-- constant leaves every ratio here unchanged, which is the property the unit
-- test pins.
--
-- ONE BAND FOR BOTH SIDES. The (grade, category) band is computed platform-wide
-- and quoted only past the k-anonymity floor AND the sample floor. The caller's
-- own items are measured against that same band, so the two sides are
-- comparable and neither can be read off a single seller.
--
-- ⚠ EMPTY defects_found IS NOT A CONTROL GROUP, and the schema is why. 00058
-- added the column as NOT NULL DEFAULT '[]', so a grade produced before it
-- looks exactly like a grade that genuinely found nothing. applied_migrations
-- only starts at 00254, so there is no honest way to date-separate them. The
-- count is reported as noDefectsRecorded and is deliberately NOT used as a
-- baseline; the band median is the baseline instead.
--
-- detected_style_attributes are excluded on purpose: they are intentional
-- design the grader recognized and did NOT penalize, so pricing them as flaws
-- would be wrong.
--
-- Guarded with gt_require_role (00640), not a REVOKE (US-2403).

BEGIN;

create or replace function public.flipdesk_defect_cost(
  p_period_start date default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  SELECT CASE WHEN public.gt_require_role('flipdesk_defect_cost', 'authenticated')
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
      5::int as min_sample,
      -- A (defect type, severity) pair needs this many items before any impact
      -- figure is quoted. Below it the row still lists, with nulls.
      5::int as min_defect
  ),
  -- Graded items with a completed sale, platform-wide, each carrying its
  -- active grade report.
  base as (
    select
      i.id,
      i.user_id,
      (round(i.grade_value * 2) / 2.0)::numeric(3,1) as grade,
      coalesce(
        nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
        'Uncategorized'
      ) as category,
      sa.sale_date,
      sa.sale_price,
      case
        when l.list_date is not null and sa.sale_date::date >= l.list_date::date
        then (sa.sale_date::date - l.list_date::date)
      end as days_to_sell,
      gr.defects_found
    from public.inventory_items i
    join lateral (
      select coalesce(sold_at, sale_date) as sale_date, sale_price
      from public.sales
      where sales.inventory_item_id = i.id
        and sales.status = 'completed'
      order by coalesce(sales.sold_at, sales.sale_date) desc nulls last,
        sales.created_at desc
      limit 1
    ) sa on true
    left join lateral (
      select listed_at as list_date
      from public.listings
      where listings.inventory_item_id = i.id
      order by listings.listed_at desc nulls last, listings.created_at desc
      limit 1
    ) l on true
    -- Three ways an item reaches its grade, because all three exist in this
    -- schema: the direct FK (00002), the shared submission (00002), and the
    -- FlipDesk grading link table (00008). Newest active report wins.
    left join lateral (
      select r.defects_found
      from public.grade_reports r
      where r.superseded_at is null
        and (
          r.id = i.grade_report_id
          or (i.submission_id is not null and r.submission_id = i.submission_id)
          or r.submission_id in (
            select fgs.submission_id
            from public.flipdesk_grading_submissions fgs
            where fgs.inventory_item_id = i.id
              and fgs.submission_id is not null
          )
        )
      order by r.created_at desc
      limit 1
    ) gr on true
    where i.grade_value is not null
      and i.grade_value >= 1.0
      and i.grade_value <= 10.0
      and sa.sale_price is not null
      and (p_period_start is null or sa.sale_date::date >= p_period_start)
  ),
  -- The normalizer. Quoted only past BOTH floors, so no band figure is ever a
  -- report on one seller.
  band as (
    select
      grade, category,
      percentile_cont(0.5) within group (order by sale_price) as med_price,
      percentile_cont(0.5) within group (order by days_to_sell) as med_days,
      count(*)::int as n,
      count(distinct user_id)::int as sellers
    from base
    group by grade, category
  ),
  scored as (
    select
      b.id, b.user_id, b.defects_found,
      b.sale_price / nullif(bd.med_price, 0) as price_ratio,
      case when bd.med_days is not null and b.days_to_sell is not null
        then b.days_to_sell - bd.med_days end as days_delta
    from base b
    join cfg c on true
    join band bd
      on bd.grade = b.grade and bd.category = b.category
     and bd.sellers >= c.min_sellers and bd.n >= c.min_sample
    where bd.med_price is not null and bd.med_price > 0
  ),
  -- One row per item per DISTINCT (defect, severity): two moderate stains on
  -- one garment are one observation, not two.
  defect_rows as (
    select distinct
      s.id, s.user_id, s.price_ratio, s.days_delta,
      coalesce(
        nullif(trim(d.value ->> 'defect_type'), ''),
        nullif(lower(trim(d.value ->> 'defect')), ''),
        'unspecified'
      ) as defect_key,
      coalesce(nullif(trim(d.value ->> 'severity'), ''), 'unspecified') as severity
    from scored s
    cross join lateral jsonb_array_elements(coalesce(s.defects_found, '[]'::jsonb)) as d
    where jsonb_typeof(s.defects_found) = 'array'
  ),
  own_rows as (
    select * from defect_rows where user_id = auth.uid()
  ),
  cohort_agg as (
    select
      defect_key, severity,
      count(*)::int as n,
      count(distinct user_id)::int as sellers,
      percentile_cont(0.5) within group (order by price_ratio) as med_ratio,
      percentile_cont(0.5) within group (order by days_delta) as med_days_delta
    from defect_rows
    group by defect_key, severity
  ),
  own_agg as (
    select
      defect_key, severity,
      count(*)::int as n,
      percentile_cont(0.5) within group (order by price_ratio) as med_ratio,
      percentile_cont(0.5) within group (order by days_delta) as med_days_delta
    from own_rows
    group by defect_key, severity
  ),
  -- FULL OUTER first, cfg SECOND. Joining cfg to own_agg before the outer join
  -- would leave every cohort-only row with a NULL threshold, and a comparison
  -- against NULL is not a refusal — it is a row that silently drops out.
  joined as (
    select
      coalesce(ca.defect_key, oa.defect_key) as defect_key,
      coalesce(ca.severity, oa.severity) as severity,
      oa.n as own_n, oa.med_ratio as own_med, oa.med_days_delta as own_days_med,
      ca.n as cohort_n, ca.sellers as cohort_sellers,
      ca.med_ratio as cohort_med, ca.med_days_delta as cohort_days_med
    from own_agg oa
    full outer join cohort_agg ca
      on ca.defect_key = oa.defect_key and ca.severity = oa.severity
  ),
  rows_out as (
    select
      j.defect_key,
      j.severity,
      coalesce(j.own_n, 0) as own_n,
      case when j.own_n >= c.min_defect then round(j.own_med::numeric, 4) end as own_ratio,
      case when j.own_n >= c.min_defect then round(j.own_days_med::numeric, 1) end as own_days,
      coalesce(j.cohort_n, 0) as cohort_n,
      coalesce(j.cohort_sellers, 0) as cohort_sellers,
      (coalesce(j.cohort_sellers, 0) < c.min_sellers
        or coalesce(j.cohort_n, 0) < c.min_defect) as cohort_suppressed,
      case when j.cohort_sellers >= c.min_sellers and j.cohort_n >= c.min_defect
        then round(j.cohort_med::numeric, 4) end as cohort_ratio,
      case when j.cohort_sellers >= c.min_sellers and j.cohort_n >= c.min_defect
        then round(j.cohort_days_med::numeric, 1) end as cohort_days
    from joined j
    cross join cfg c
  )
  select jsonb_build_object(
    'periodStart', p_period_start,
    'minSellers', (select min_sellers from cfg),
    'minSample', (select min_sample from cfg),
    'minDefectSample', (select min_defect from cfg),
    -- Coverage, so a thin ledger reads as thin rather than as a finding.
    'itemsSold', (select count(*)::int from base where user_id = auth.uid()),
    'itemsScored', (select count(*)::int from scored where user_id = auth.uid()),
    'itemsWithDefects', (select count(distinct id)::int from own_rows),
    'noDefectsRecorded', (
      select count(*)::int from scored
      where user_id = auth.uid()
        and coalesce(jsonb_array_length(
          case when jsonb_typeof(defects_found) = 'array'
            then defects_found else '[]'::jsonb end), 0) = 0
    ),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'defect', defect_key,
        'severity', severity,
        'ownCount', own_n,
        'ownPriceRatio', own_ratio,
        'ownDaysDelta', own_days,
        'cohortCount', cohort_n,
        'cohortSellers', cohort_sellers,
        'cohortSuppressed', cohort_suppressed,
        'cohortPriceRatio', cohort_ratio,
        'cohortDaysDelta', cohort_days
      )
      -- Most expensive first: the lowest surviving ratio. Rows with no quotable
      -- ratio sort last rather than sorting as zero.
      order by coalesce(cohort_ratio, own_ratio) asc nulls last, defect_key, severity)
      from rows_out
    ), '[]'::jsonb)
  )
  ) END;
$$;

grant execute on function public.flipdesk_defect_cost(date) to authenticated;
grant execute on function public.flipdesk_defect_cost(date) to service_role;

insert into public.applied_migrations (version) values ('00653') on conflict do nothing;

COMMIT;
