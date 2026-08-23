-- US-2827: is your medium the same medium everybody else is selling?
--
-- Sizes are not a standard, they are a brand's opinion, and a seller measuring
-- flat by their own habit drifts from everyone else's habit without any signal
-- that it happened. The buyer finds out. This compares the caller's median
-- measurement for a (garment category, size, measurement) against the cohort's,
-- and reports what the drift costs in returns.
--
-- ── ONLY THE INCH MEASUREMENTS, and that is not laziness ───────────────────
-- MEASUREMENT_SPECS (src/lib/measurements.ts) carries three kinds: `length` in
-- inches, `shoe` as a US numeric size, and `mm` for watch dimensions. Only
-- `length` is a flat measurement that means the same thing across sellers. A
-- US 10 is not a measurement and a case diameter is not a fit, so pooling them
-- would produce a cohort median for a quantity that has no cohort. The key list
-- below is the `length` half of that record, copied deliberately; if a key is
-- added there, add it here.
--
-- SECURITY DEFINER, because this is the only way to reach other sellers' rows,
-- and every cohort figure passes the same k-anonymity floor community_benchmarks
-- reads from system_settings, hard-clamped with greatest(5, ...). The caller's
-- own median is returned at any sample size: it is their data.
--
-- ⚠ VALUES ARE COERCED, NOT ASSUMED. inventory_items.measurements is jsonb typed
-- Record<string, number | string> on the client, so a value can arrive as "21"
-- or as 21 or as "21 in". The regex below accepts only a bare number; anything
-- else is skipped rather than silently becoming 0, because a 0-inch chest would
-- drag a cohort median down and look like a real measurement.
--
-- Guarded with gt_require_role (00640), not a REVOKE (US-2403).

BEGIN;

create or replace function public.measurement_drift(
  p_garment_category text default null,
  -- ⚠ WHY A SIZE PARAMETER EXISTS AT ALL. `rows` below is built from the
  -- caller's OWN buckets outward, which is right for the analytics panel and
  -- useless for the composer: a seller entering measurements for their first
  -- size-M jacket has no own bucket, so the cohort band they most need would
  -- not be in the payload. `bands` is built from the cohort alone for one
  -- (category, size), so the live check works on the first item rather than
  -- only after the fifth.
  p_size text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  SELECT CASE WHEN public.gt_require_role('measurement_drift', 'authenticated')
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
      -- Items the caller needs at a (category, size, key) before their own
      -- median is compared to anything.
      3::int as min_measure,
      -- Mirrors MIN_RETURN_SAMPLE (flipdesk-returns-analytics.ts).
      10::int as min_return,
      -- Inches. Past this the listing and the garment disagree enough to matter.
      1.0::numeric as drift_inches
  ),
  -- The `length` half of MEASUREMENT_SPECS. See the header.
  length_keys(key) as (
    values ('chest'), ('bust'), ('waist'), ('hip'), ('inseam'), ('rise'),
           ('leg_opening'), ('sleeve'), ('shoulder'), ('length'), ('width'),
           ('insole')
  ),
  base as (
    select
      i.user_id,
      i.id,
      coalesce(nullif(trim(i.garment_category::text), ''), 'Uncategorized') as garment_category,
      upper(nullif(trim(i.size), '')) as size,
      i.measurements,
      sa.status as sale_status
    from public.inventory_items i
    left join lateral (
      select s.status
      from public.sales s
      where s.inventory_item_id = i.id
      order by coalesce(s.sold_at, s.sale_date) desc nulls last, s.created_at desc
      limit 1
    ) sa on true
    where i.measurements is not null
      and jsonb_typeof(i.measurements) = 'object'
      and nullif(trim(i.size), '') is not null
      and (
        p_garment_category is null
        or lower(coalesce(nullif(trim(i.garment_category::text), ''), 'Uncategorized'))
           = lower(trim(p_garment_category))
      )
  ),
  -- One row per (item, measurement key) with a usable numeric value.
  vals as (
    select
      b.user_id, b.id, b.garment_category, b.size, b.sale_status,
      m.key,
      (m.value #>> '{}')::numeric as inches
    from base b
    cross join lateral jsonb_each(b.measurements) as m(key, value)
    join length_keys lk on lk.key = m.key
    where jsonb_typeof(m.value) in ('number', 'string')
      -- A bare number only. "21 in", "" and "about 21" are skipped, not zeroed.
      and (m.value #>> '{}') ~ '^[0-9]+(\.[0-9]+)?$'
      and (m.value #>> '{}')::numeric > 0
      and (m.value #>> '{}')::numeric < 200
  ),
  cohort as (
    select garment_category, size, key,
      count(*)::int as n,
      count(distinct user_id)::int as sellers,
      percentile_cont(0.25) within group (order by inches) as p25,
      percentile_cont(0.50) within group (order by inches) as p50,
      percentile_cont(0.75) within group (order by inches) as p75
    from vals group by garment_category, size, key
  ),
  own as (
    select garment_category, size, key,
      count(*)::int as n,
      percentile_cont(0.5) within group (order by inches) as p50
    from vals where user_id = auth.uid()
    group by garment_category, size, key
  ),
  -- The caller's items scored against the cohort median for their own bucket.
  -- Only buckets past the seller floor take part: a "drift" measured against
  -- two other sellers is a comparison with those two sellers.
  scored_items as (
    select distinct
      v.id,
      v.sale_status,
      (abs(v.inches - c.p50) > (select drift_inches from cfg)) as is_off
    from vals v
    join cohort c
      on c.garment_category = v.garment_category
     and c.size = v.size
     and c.key = v.key
     and c.sellers >= (select min_sellers from cfg)
    where v.user_id = auth.uid()
  ),
  -- An item counts as "off" if ANY of its measurements drifted.
  item_flags as (
    select id,
      bool_or(is_off) as any_off,
      max(sale_status) as sale_status
    from scored_items group by id
  ),
  return_split as (
    select
      any_off,
      count(*) filter (where sale_status in ('completed', 'refunded'))::int as fulfilled,
      count(*) filter (where sale_status = 'refunded')::int as returns
    from item_flags group by any_off
  )
  select jsonb_build_object(
    'garmentCategory', p_garment_category,
    'minSellers', (select min_sellers from cfg),
    'minMeasure', (select min_measure from cfg),
    'minReturn', (select min_return from cfg),
    'driftInches', (select drift_inches from cfg),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'garmentCategory', o.garment_category,
        'size', o.size,
        'key', o.key,
        'ownCount', o.n,
        'ownMedian', case when o.n >= c.min_measure
          then round(o.p50::numeric, 2) end,
        'cohortCount', coalesce(ch.n, 0),
        'cohortSellers', coalesce(ch.sellers, 0),
        'cohortSuppressed', coalesce(ch.sellers, 0) < c.min_sellers,
        'cohortMedian', case when ch.sellers >= c.min_sellers
          then round(ch.p50::numeric, 2) end,
        'cohortP25', case when ch.sellers >= c.min_sellers
          then round(ch.p25::numeric, 2) end,
        'cohortP75', case when ch.sellers >= c.min_sellers
          then round(ch.p75::numeric, 2) end,
        'driftInches', case
          when o.n >= c.min_measure and ch.sellers >= c.min_sellers
          then round((o.p50 - ch.p50)::numeric, 2) end
      ) order by
        -- Biggest absolute drift first; unquotable rows last.
        case when o.n >= c.min_measure and ch.sellers >= c.min_sellers
          then abs(o.p50 - ch.p50) end desc nulls last,
        o.garment_category, o.size, o.key)
      from own o
      cross join cfg c
      left join cohort ch
        on ch.garment_category = o.garment_category
       and ch.size = o.size
       and ch.key = o.key
    ), '[]'::jsonb),
    -- Cohort-only bands for ONE (category, size), independent of whether the
    -- caller has ever measured that bucket. Empty unless p_size is supplied.
    'bands', coalesce((
      select jsonb_agg(jsonb_build_object(
        'garmentCategory', ch.garment_category,
        'size', ch.size,
        'key', ch.key,
        'cohortCount', ch.n,
        'cohortSellers', ch.sellers,
        'cohortSuppressed', ch.sellers < c.min_sellers,
        'cohortMedian', case when ch.sellers >= c.min_sellers
          then round(ch.p50::numeric, 2) end,
        'cohortP25', case when ch.sellers >= c.min_sellers
          then round(ch.p25::numeric, 2) end,
        'cohortP75', case when ch.sellers >= c.min_sellers
          then round(ch.p75::numeric, 2) end
      ) order by ch.key)
      from cohort ch cross join cfg c
      where p_size is not null
        and upper(trim(p_size)) = ch.size
    ), '[]'::jsonb),
    'returns', jsonb_build_object(
      'offCount', coalesce((select fulfilled from return_split where any_off), 0),
      'offReturns', coalesce((select returns from return_split where any_off), 0),
      'offRate', (
        select case when fulfilled >= (select min_return from cfg)
          then round(returns::numeric / fulfilled, 4) end
        from return_split where any_off
      ),
      'withinCount', coalesce((select fulfilled from return_split where not any_off), 0),
      'withinReturns', coalesce((select returns from return_split where not any_off), 0),
      'withinRate', (
        select case when fulfilled >= (select min_return from cfg)
          then round(returns::numeric / fulfilled, 4) end
        from return_split where not any_off
      )
    )
  )
  ) END;
$$;

grant execute on function public.measurement_drift(text, text) to authenticated;
grant execute on function public.measurement_drift(text, text) to service_role;

insert into public.applied_migrations (version) values ('00658') on conflict do nothing;

COMMIT;
