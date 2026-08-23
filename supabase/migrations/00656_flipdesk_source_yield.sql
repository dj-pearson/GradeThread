-- US-2824: source condition yield.
--
-- flipdesk_sell_through(source) already answers "which venue sells". It cannot
-- answer the question that comes first, which is "which venue is worth the
-- drive": what condition the goods are in when you buy them, and what a point
-- of grade costs there.
--
-- COST PER GRADE POINT is the number this exists for. A bin run at $1.10 an
-- item yielding a median 6.4 and a curated rack at $4.20 yielding an 8.2 are
-- not comparable on price and are not comparable on grade; they are comparable
-- on price divided by grade.
--
-- THE WINDOW IS THE PURCHASE DATE, NOT THE SALE DATE, and that is the whole
-- design. Attributing an outcome to a source means asking what happened to the
-- things bought THERE, THEN. Windowing on sale date would credit a venue for
-- inventory bought two years earlier and blame it for stock that has not sold
-- yet. Every downstream figure (sell-through, profit, days) is therefore
-- measured over items SOURCED in the window, whenever they happened to sell.
--
-- SECURITY INVOKER over items_full, like 00168. sources are per-seller and
-- there is no cross-seller aggregate here, so no k-anonymity question arises.
--
-- ⚠ Items with no purchase_price are excluded from the price-derived figures
-- and counted separately. A free item is real, and dividing by its zero cost is
-- not: it would make any venue that ever gave something away infinitely good.

BEGIN;

create or replace function public.flipdesk_source_yield(
  p_period_start date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with cfg as (
    -- A venue needs this many items sourced in the window before any derived
    -- figure is quoted. Below it the row lists with counts and nulls.
    select 5::int as min_sample
  ),
  sourced as (
    select
      coalesce(nullif(trim(source_name), ''), 'No source') as source,
      purchase_price,
      grade_value,
      net_profit,
      days_to_sell,
      (list_date is not null) as was_listed,
      (sale_date is not null and sale_status = 'completed') as was_sold
    from public.items_full
    where purchase_date is not null
      and (p_period_start is null or purchase_date::date >= p_period_start)
  ),
  agg as (
    select
      source,
      count(*)::int as items,
      count(purchase_price)::int as with_price,
      count(grade_value)::int as graded,
      count(*) filter (where was_listed)::int as listed,
      count(*) filter (where was_sold)::int as sold,
      avg(purchase_price) filter (where purchase_price > 0) as avg_price,
      percentile_cont(0.5) within group (order by grade_value) as med_grade,
      percentile_cont(0.5) within group (
        order by case when was_sold then net_profit end
      ) as med_profit,
      percentile_cont(0.5) within group (
        order by case when was_sold then days_to_sell end
      ) as med_days
    from sourced
    group by source
  )
  select jsonb_build_object(
    'periodStart', p_period_start,
    'minSample', (select min_sample from cfg),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source', a.source,
        'itemsSourced', a.items,
        'itemsWithPrice', a.with_price,
        'gradedCount', a.graded,
        'gradedShare', case when a.items > 0
          then round(a.graded::numeric / a.items, 4) end,
        'listed', a.listed,
        'sold', a.sold,
        -- Every derived figure below is gated on the sample floor together, so
        -- a thin venue never shows three trustworthy numbers and one that is
        -- really a single item.
        'avgPurchasePrice', case when a.items >= c.min_sample
          then round(a.avg_price::numeric, 2) end,
        'medianGrade', case when a.items >= c.min_sample
          then round(a.med_grade::numeric, 1) end,
        -- The headline. Null unless BOTH halves exist and the grade is above
        -- zero: a division by a null or zero median grade is not a cost.
        'costPerGradePoint', case
          when a.items >= c.min_sample
            and a.avg_price is not null
            and a.med_grade is not null
            and a.med_grade > 0
          then round((a.avg_price / a.med_grade)::numeric, 2) end,
        'medianNetProfit', case when a.sold >= c.min_sample
          then round(a.med_profit::numeric, 2) end,
        'medianDaysToSell', case when a.sold >= c.min_sample
          then round(a.med_days::numeric, 1) end,
        'sellThrough', case
          when a.items >= c.min_sample and a.listed > 0
          then round(a.sold::numeric / a.listed, 4) end,
        'thin', a.items < c.min_sample
      ) order by a.items desc, a.source)
      from agg a cross join cfg c
    ), '[]'::jsonb),
    'itemsWithoutPrice', (
      select count(*)::int from sourced where purchase_price is null or purchase_price <= 0
    ),
    'itemsWithoutPurchaseDate', (
      -- Reported so an empty report reads as "nothing is stamped" rather than
      -- as "you sourced nothing".
      select count(*)::int from public.items_full where purchase_date is null
    )
  );
$$;

grant execute on function public.flipdesk_source_yield(date) to authenticated;
grant execute on function public.flipdesk_source_yield(date) to service_role;

insert into public.applied_migrations (version) values ('00656') on conflict do nothing;

COMMIT;
