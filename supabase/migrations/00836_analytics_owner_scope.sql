-- INV-D1 follow-up: the FlipDesk Analytics page reads ONE workspace.
--
-- The RPCs behind /dashboard/flipdesk/analytics had no owner argument. The
-- SECURITY INVOKER ones read items_full or listings, whose SELECT policies
-- admit the caller's own rows OR any workspace they belong to, so a seller who
-- is also a member elsewhere saw both tenants blended. The two SECURITY
-- DEFINER ones (seller_scorecard, community_benchmarks) built their "you"
-- figures from auth.uid(), so a member inside an owner's workspace saw their
-- OWN numbers labelled as the workspace's. 00833/00834/00835 fixed the same gap
-- for Inventory, the Overview and search; this is that fix, copied.
--
-- Every function here takes p_owner_id uuid default null, the workspace on
-- screen. It is checked, not trusted: the caller must be that owner, a member
-- of it (public.is_workspace_member), or the service role, else 42501. NULL
-- means auth.uid(), the caller's own rows. The owner filter sits where the rows
-- are read, before any count, median or limit. Anon is refused with 42501 (the
-- 00834 check for the invokers, gt_require_role for the definers).
--
-- Replaced in place (old signature dropped, so PostgREST sees one overload):
-- flipdesk_sell_through, flipdesk_grading_roi, flipdesk_grading_roi_summary,
-- seller_scorecard, flipdesk_listing_performance_summary and _page. Only the
-- web calls those. ADDED beside v1, which is left untouched:
-- flipdesk_return_reduction_v2 (iOS ReturnReductionStore calls v1) and
-- community_benchmarks_v2 (iOS and Android call v1).
--
-- The definers keep SECURITY DEFINER and their cohort exactly as it was. Only
-- the "you" slice moves from auth.uid() to the owner: seller_scorecard's own
-- metrics and return split, community_benchmarks' you block including which
-- seller its peer comparison leaves out. Every k-anonymity floor is untouched.
--
-- Bodies are the last definitions verbatim (00148, 00505, 00717, 00640, 00560,
-- 00168) apart from the guard, the owner predicate and plpgsql (a SQL function
-- cannot raise). Grants are replayed as they were. No revokes (US-2403, the
-- 00831 note), which means the two listing-performance functions come back with
-- the PUBLIC default that 00560 had revoked; the body refuses anon instead,
-- which is the settled remedy (00686, 00720, 00726).
--
-- The en dash in the '$50-150' band label is 00505's byte for byte (the client
-- matches on it); the em dashes are inside copied comments.
-- Proof: node scripts/check-analytics-owner-scope.mjs --dsn "postgresql://..."

-- ── flipdesk_sell_through ──────────────────────────────────────────────────
drop function if exists public.flipdesk_sell_through(text, date);

create or replace function public.flipdesk_sell_through(
  p_group_key text default 'category',
  p_period_start date default null,
  -- 00836: the workspace on screen. NULL = the caller's own rows.
  p_owner_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $fn$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  if auth.role() is not null and auth.role() not in ('service_role', 'authenticated') then
    raise exception 'flipdesk_sell_through: sign-in required' using errcode = '42501';
  end if;
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'flipdesk_sell_through: not a member of that workspace'
      using errcode = '42501';
  end if;

  return (
  with hits as (
    select
      case p_group_key
        when 'brand'  then coalesce(nullif(trim(brand), ''), 'No brand')
        when 'source' then coalesce(nullif(trim(source_name), ''), 'No source')
        else               coalesce(nullif(trim(category), ''), 'Uncategorized')
      end as grp,
      (list_date is not null
        and (p_period_start is null or list_date::date >= p_period_start)) as listed_hit,
      (sale_date is not null
        and (p_period_start is null or sale_date::date >= p_period_start)) as sold_hit,
      net_profit,
      days_to_sell
    from public.items_full
    -- 00836: one workspace, before anything is counted.
    where user_id = v_owner
  ),
  agg as (
    select
      grp,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(net_profit) filter (where sold_hit and net_profit is not null) as avg_net_profit,
      percentile_cont(0.5) within group (order by days_to_sell)
        filter (where sold_hit and days_to_sell is not null) as median_days
    from hits
    where listed_hit or sold_hit
    group by grp
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'group', grp,
        'listed', listed,
        'sold', sold,
        'sellThrough', case when listed > 0 then sold::numeric / listed else null end,
        'avgNetProfit', avg_net_profit,
        'medianDaysToSell', median_days
      )
      order by sold desc, listed desc
    ),
    '[]'::jsonb
  )
  from agg
  );
end;
$fn$;

comment on function public.flipdesk_sell_through(text, date, uuid) is
  'US-418: sell-through and profit by category/brand/source. SECURITY INVOKER. 00836: one '
  'workspace (p_owner_id, NULL = the caller''s own), 42501 for a non-member or anon.';

grant execute on function public.flipdesk_sell_through(text, date, uuid) to authenticated;
grant execute on function public.flipdesk_sell_through(text, date, uuid) to service_role;

-- ── flipdesk_grading_roi_summary ───────────────────────────────────────────
drop function if exists public.flipdesk_grading_roi_summary(date);

create or replace function public.flipdesk_grading_roi_summary(
  p_period_start date default null,
  -- 00836: the workspace on screen. NULL = the caller's own rows.
  p_owner_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $fn$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  if auth.role() is not null and auth.role() not in ('service_role', 'authenticated') then
    raise exception 'flipdesk_grading_roi_summary: sign-in required' using errcode = '42501';
  end if;
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'flipdesk_grading_roi_summary: not a member of that workspace'
      using errcode = '42501';
  end if;

  return (
  with base as (
    select
      (grade_value is not null) as is_graded,
      (list_date is not null
        and (p_period_start is null or list_date::date >= p_period_start)) as listed_hit,
      (sale_date is not null
        and (p_period_start is null or sale_date::date >= p_period_start)) as sold_hit,
      net_profit,
      days_to_sell
    from public.items_full
    -- 00836: one workspace, before anything is counted.
    where user_id = v_owner
  ),
  side as (
    select
      is_graded,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(net_profit) filter (where sold_hit and net_profit is not null) as avg_net_profit,
      percentile_cont(0.5) within group (order by days_to_sell)
        filter (where sold_hit and days_to_sell is not null) as median_days
    from base
    group by is_graded
  ),
  g as (select * from side where is_graded),
  u as (select * from side where not is_graded)
  select jsonb_build_object(
    'graded', jsonb_build_object(
      'listed', coalesce((select listed from g), 0),
      'sold', coalesce((select sold from g), 0),
      'sellThrough', (select case when listed > 0 then sold::numeric / listed else null end from g),
      'avgNetProfit', (select avg_net_profit from g),
      'medianDaysToSell', (select median_days from g)
    ),
    'ungraded', jsonb_build_object(
      'listed', coalesce((select listed from u), 0),
      'sold', coalesce((select sold from u), 0),
      'sellThrough', (select case when listed > 0 then sold::numeric / listed else null end from u),
      'avgNetProfit', (select avg_net_profit from u),
      'medianDaysToSell', (select median_days from u)
    ),
    'sellThroughLift', (
      select gst - ust
      from (select case when g.listed > 0 then g.sold::numeric / g.listed end as gst from g) gx,
           (select case when u.listed > 0 then u.sold::numeric / u.listed end as ust from u) ux
    ),
    'netProfitLift', (
      select g.avg_net_profit - u.avg_net_profit
      from g, u
      where g.avg_net_profit is not null and u.avg_net_profit is not null
    ),
    'daysFaster', (
      select u.median_days - g.median_days
      from g, u
      where g.median_days is not null and u.median_days is not null
    ),
    'meaningful', (
      coalesce((select sold from g), 0) >= 5
      and coalesce((select sold from u), 0) >= 5
    )
  )
  );
end;
$fn$;

comment on function public.flipdesk_grading_roi_summary(date, uuid) is
  'US-2234: graded vs ungraded headline. SECURITY INVOKER. 00836: one workspace '
  '(p_owner_id, NULL = the caller''s own), 42501 for a non-member or anon.';

grant execute on function public.flipdesk_grading_roi_summary(date, uuid) to authenticated;
grant execute on function public.flipdesk_grading_roi_summary(date, uuid) to service_role;

-- ── flipdesk_grading_roi ───────────────────────────────────────────────────
drop function if exists public.flipdesk_grading_roi(date);

create or replace function public.flipdesk_grading_roi(
  p_period_start date default null,
  -- 00836: the workspace on screen. NULL = the caller's own rows.
  p_owner_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $fn$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  if auth.role() is not null and auth.role() not in ('service_role', 'authenticated') then
    raise exception 'flipdesk_grading_roi: sign-in required' using errcode = '42501';
  end if;
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'flipdesk_grading_roi: not a member of that workspace'
      using errcode = '42501';
  end if;

  return (
  with sold as (
    select
      coalesce(nullif(trim(category), ''), 'Uncategorized') as category,
      case
        when sale_price < 50  then 'Under $50'
        when sale_price < 150 then '$50–150'
        else                       '$150+'
      end as band,
      (grade_value is not null) as is_graded,
      net_profit,
      sale_price,
      days_to_sell
    from public.items_full
    -- 00836: one workspace, before anything is counted.
    where user_id = v_owner
      and sale_price is not null
      and (p_period_start is null or sale_date::date >= p_period_start)
  ),
  agg as (
    select
      category,
      band,
      count(*) filter (where is_graded)         as graded_count,
      avg(net_profit) filter (where is_graded)  as graded_profit,
      avg(sale_price) filter (where is_graded)  as graded_price,
      percentile_cont(0.5) within group (order by days_to_sell)
        filter (where is_graded and days_to_sell is not null) as graded_days,
      count(*) filter (where not is_graded)     as ungraded_count,
      avg(net_profit) filter (where not is_graded) as ungraded_profit,
      avg(sale_price) filter (where not is_graded) as ungraded_price,
      percentile_cont(0.5) within group (order by days_to_sell)
        filter (where not is_graded and days_to_sell is not null) as ungraded_days
    from sold
    group by category, band
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'category', category,
        'band', band,
        'graded', jsonb_build_object(
          'count', graded_count,
          'avgNetProfit', graded_profit,
          'avgSalePrice', graded_price,
          'medianDaysToSell', graded_days
        ),
        'ungraded', jsonb_build_object(
          'count', ungraded_count,
          'avgNetProfit', ungraded_profit,
          'avgSalePrice', ungraded_price,
          'medianDaysToSell', ungraded_days
        ),
        'netProfitLift', case
          when graded_profit is not null and ungraded_profit is not null
            then graded_profit - ungraded_profit
          else null
        end,
        'meaningful', (graded_count >= 5 and ungraded_count >= 5)
      )
      order by category,
        case band when 'Under $50' then 0 when '$50–150' then 1 else 2 end
    ),
    '[]'::jsonb
  )
  from agg
  );
end;
$fn$;

comment on function public.flipdesk_grading_roi(date, uuid) is
  'US-2234: graded vs ungraded by category and price band. SECURITY INVOKER. 00836: one '
  'workspace (p_owner_id, NULL = the caller''s own), 42501 for a non-member or anon.';

grant execute on function public.flipdesk_grading_roi(date, uuid) to authenticated;
grant execute on function public.flipdesk_grading_roi(date, uuid) to service_role;

-- ── flipdesk_return_reduction_v2 (v1 is left for the iOS app) ──────────────
create or replace function public.flipdesk_return_reduction_v2(
  p_period_start date default null,
  -- The workspace on screen. NULL = the caller's own rows.
  p_owner_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $fn$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  if auth.role() is not null and auth.role() not in ('service_role', 'authenticated') then
    raise exception 'flipdesk_return_reduction_v2: sign-in required' using errcode = '42501';
  end if;
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'flipdesk_return_reduction_v2: not a member of that workspace'
      using errcode = '42501';
  end if;

  return (
  with fulfilled as (
    select
      grade_value,
      (grade_value is not null)            as is_graded,
      (sale_status = 'refunded')           as is_return,
      case
        when grade_value is null  then 'ungraded'
        when grade_value <= 6     then 'low'
        when grade_value <= 8     then 'mid'
        else                           'high'
      end as band
    from public.items_full
    -- 00836: one workspace, before anything is counted.
    where user_id = v_owner
      and sale_status in ('completed', 'refunded')
      and (
        p_period_start is null
        or coalesce(sale_date, sold_at_raw)::date >= p_period_start
      )
  ),
  by_band as (
    select
      band,
      count(*)::int                              as sold,
      count(*) filter (where is_return)::int     as returns
    from fulfilled
    group by band
  ),
  -- Stable, ordered band rows (worst grade first) so the UI can read them
  -- directly. LEFT JOIN against the canonical band list keeps a band present
  -- with zero counts rather than dropping it.
  bands as (
    select
      b.key,
      b.label,
      coalesce(bb.sold, 0)    as sold,
      coalesce(bb.returns, 0) as returns,
      b.ord
    from (values
      ('low',      'Graded 6.0 or lower', 0),
      ('mid',      'Graded 6.5 - 8.0',    1),
      ('high',     'Graded 8.5 - 10.0',   2),
      ('ungraded', 'Ungraded',            3)
    ) as b(key, label, ord)
    left join by_band bb on bb.band = b.key
  ),
  rollup as (
    select
      count(*) filter (where is_graded)::int                          as graded_sold,
      count(*) filter (where is_graded and is_return)::int            as graded_returns,
      count(*) filter (where not is_graded)::int                      as ungraded_sold,
      count(*) filter (where not is_graded and is_return)::int        as ungraded_returns,
      count(*)::int                                                   as total_sold,
      count(*) filter (where is_return)::int                          as total_returns
    from fulfilled
  )
  select jsonb_build_object(
    'overall', jsonb_build_object(
      'sold', r.total_sold,
      'returns', r.total_returns,
      'returnRate', case when r.total_sold > 0
        then r.total_returns::numeric / r.total_sold else null end
    ),
    'graded', jsonb_build_object(
      'sold', r.graded_sold,
      'returns', r.graded_returns,
      'returnRate', case when r.graded_sold > 0
        then r.graded_returns::numeric / r.graded_sold else null end
    ),
    'ungraded', jsonb_build_object(
      'sold', r.ungraded_sold,
      'returns', r.ungraded_returns,
      'returnRate', case when r.ungraded_sold > 0
        then r.ungraded_returns::numeric / r.ungraded_sold else null end
    ),
    'bands', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', key,
          'label', label,
          'sold', sold,
          'returns', returns,
          'returnRate', case when sold > 0
            then returns::numeric / sold else null end
        )
        order by ord
      )
      from bands
    ), '[]'::jsonb)
  )
  from rollup r
  );
end;
$fn$;

comment on function public.flipdesk_return_reduction_v2(date, uuid) is
  '00836: flipdesk_return_reduction (00168) for ONE workspace (p_owner_id, NULL = the '
  'caller''s own), 42501 for a non-member or anon. SECURITY INVOKER. The web calls this; '
  'the iOS app still calls v1.';

grant execute on function public.flipdesk_return_reduction_v2(date, uuid) to authenticated;
grant execute on function public.flipdesk_return_reduction_v2(date, uuid) to service_role;

-- ── seller_scorecard (SECURITY DEFINER: the cohort reads every seller) ──────
-- The cohort (seller_metrics, pool, dist) is 00717's, unchanged. Only `mine`
-- and `split`, the caller's own figures, read the owner instead of auth.uid().
drop function if exists public.seller_scorecard(date);

create or replace function public.seller_scorecard(
  p_period_start date default null,
  -- 00836: the workspace on screen. NULL = the caller's own figures.
  p_owner_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  -- 00640's guard, first: signed in, service role or admin, else 42501.
  perform public.gt_require_role('seller_scorecard', 'authenticated');
  -- The owner, any member of the owner's workspace, or the service role. This
  -- is the check that stops a definer handing one seller another's figures.
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'seller_scorecard: not a member of that workspace'
      using errcode = '42501';
  end if;

  return (
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
      -- US-9208: WHEN the grade existed, so "graded at sale time" is a fact
      -- about the sale rather than about the item today.
      gr.created_at as graded_at,
      i.acquired_date,
      l.list_date,
      l.list_price,
      sa.sale_date,
      sa.sale_price,
      sa.status as sale_status
    from public.inventory_items i
    left join public.grade_reports gr on gr.id = i.grade_report_id
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
        and (p_period_start is null or acquired_date::date >= p_period_start)) as sourced_hit,
      -- US-9208: the listing carried a grade when it sold. A grade issued after
      -- the sale did not help the buyer decide and is not counted.
      (graded_at is not null and sale_date is not null and graded_at <= sale_date) as graded_at_sale
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
    select metric, value, n from seller_metrics where user_id = v_owner
  ),
  -- US-9208: the caller's own return rate split by whether the sold listing
  -- carried a grade at sale time. Counts only; the client applies the
  -- sample floor and never shows a percentage under it.
  split as (
    select
      count(*) filter (where fulfilled_hit and graded_at_sale)::int       as graded_fulfilled,
      count(*) filter (where refunded_hit and graded_at_sale)::int        as graded_returns,
      count(*) filter (where fulfilled_hit and not graded_at_sale)::int   as ungraded_fulfilled,
      count(*) filter (where refunded_hit and not graded_at_sale)::int    as ungraded_returns
    from win where user_id = v_owner
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
    'returnSplit', (
      select jsonb_build_object(
        'graded', jsonb_build_object('fulfilled', graded_fulfilled, 'returns', graded_returns),
        'ungraded', jsonb_build_object('fulfilled', ungraded_fulfilled, 'returns', ungraded_returns)
      ) from split
    ),
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
  );
end;
$fn$;

comment on function public.seller_scorecard(date, uuid) is
  'US-2822 / US-9208: the seller against a k-anonymous cohort. SECURITY DEFINER, body-guarded. '
  '00836: the own-figures slice is the p_owner_id workspace (NULL = the caller), 42501 for a '
  'non-member; the cohort is unchanged.';

grant execute on function public.seller_scorecard(date, uuid) to authenticated;
grant execute on function public.seller_scorecard(date, uuid) to service_role;

-- ── community_benchmarks_v2 (SECURITY DEFINER; v1 is left for the apps) ────
-- Every aggregate outside `you` is 00640's, byte for byte, with its k-anonymity
-- floors. Only the `you` block reads the owner: caller, caller_raw, caller_sold,
-- and peers, which is "every seller but you" and so leaves out the owner.
create or replace function public.community_benchmarks_v2(
  p_period_start date default null,
  p_brand text default null,
  p_category text default null,
  p_size text default null,
  p_price_min numeric default null,
  p_price_max numeric default null,
  -- The workspace on screen. NULL = the caller's own figures.
  p_owner_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  -- 00640's guard, first: signed in, service role or admin, else 42501.
  perform public.gt_require_role('community_benchmarks_v2', 'authenticated');
  -- The owner, any member of the owner's workspace, or the service role.
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'community_benchmarks_v2: not a member of that workspace'
      using errcode = '42501';
  end if;

  return (
with cfg as (
    -- Configured threshold, clamped to a hard floor of 5. Never lets an operator
    -- weaken k-anonymity below the documented guarantee.
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
  base as (
    -- One row per inventory item, platform-wide, with its latest listing/sale.
    select
      i.user_id,
      coalesce(nullif(trim(i.brand), ''), 'No brand') as brand,
      coalesce(
        nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
        'Uncategorized'
      ) as category,
      nullif(trim(i.size), '') as size,
      l.list_date,
      l.list_price,
      sa.sale_date,
      sa.sale_price
    from public.inventory_items i
    left join lateral (
      select listed_at as list_date, listing_price as list_price
      from public.listings
      where listings.inventory_item_id = i.id
      order by listings.listed_at desc nulls last, listings.created_at desc
      limit 1
    ) l on true
    left join lateral (
      select coalesce(sold_at, sale_date) as sale_date, sale_price
      from public.sales
      where sales.inventory_item_id = i.id
      order by coalesce(sales.sold_at, sales.sale_date) desc nulls last,
        sales.created_at desc
      limit 1
    ) sa on true
    -- ── US-2235 AC1: THE FILTERS GO HERE, AND ONLY HERE ────────────────────
    --
    -- Applying them to `base` is what makes this safe, and it is worth being
    -- explicit about why, because filtering is exactly how a k-anonymity
    -- guarantee gets broken. Every aggregate below already carries its own
    -- `sellers >= min_sellers` guard. Narrowing `base` means each of those
    -- guards re-evaluates against the FILTERED cohort — so an attacker who
    -- filters down to one seller gets nulls everywhere, not that seller's
    -- numbers. No new guard is needed, and none may be added downstream: a
    -- filter applied in the OUTPUT projection instead would leave every guard
    -- counting the unfiltered population and would hand back a cohort of one.
    --
    -- The caller's own "you" section is unaffected by that reasoning — it is
    -- their data — but it IS filtered too, which is the honest behaviour:
    -- "your sell-through on Nike" should mean Nike.
    where (p_brand is null
        or lower(coalesce(nullif(trim(i.brand), ''), 'No brand')) = lower(trim(p_brand)))
      and (p_category is null
        or lower(coalesce(
             nullif(trim(coalesce(i.item_category::text, i.garment_category::text)), ''),
             'Uncategorized'
           )) = lower(trim(p_category)))
      -- An item with NO size cannot match a size filter. Treating null as a
      -- match would silently widen the cohort past what the seller asked for.
      and (p_size is null
        or lower(coalesce(nullif(trim(i.size), ''), '')) = lower(trim(p_size)))
      -- Same for price: an unlisted item has no list price, so it is outside
      -- any band rather than inside every one.
      and (p_price_min is null or (l.list_price is not null and l.list_price >= p_price_min))
      and (p_price_max is null or (l.list_price is not null and l.list_price <= p_price_max))
  ),
  hits as (
    -- Apply the period window once; an item is "listed"/"sold" in-window the
    -- same way flipdesk_sell_through defines it (null period = all time).
    select
      user_id,
      brand,
      category,
      size,
      list_date,
      list_price,
      sale_date,
      sale_price,
      (list_date is not null
        and (p_period_start is null or list_date::date >= p_period_start)) as listed_hit,
      (sale_date is not null
        and (p_period_start is null or sale_date::date >= p_period_start)) as sold_hit
    from base
  ),
  -- In-window sold items with the two derived per-item facts the deep-dives need:
  -- days listed→sold and sale/list price realization. percentile_cont ignores the
  -- NULLs from items missing a list date / list price, so no extra filtering.
  sold_items as (
    select
      user_id,
      brand,
      category,
      sale_price,
      list_price,
      case when list_date is not null and sale_date::date >= list_date::date
        then (sale_date::date - list_date::date) end as days_to_sell,
      case when list_price is not null and list_price > 0 and sale_price is not null
        then sale_price::numeric / list_price end as realization
    from hits
    where sold_hit
  ),
  -- ── Brand deep-dive (k-anonymous) ─────────────────────────────────────────
  brand_agg as (
    select
      brand,
      count(distinct user_id) filter (where listed_hit or sold_hit) as sellers,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(sale_price) filter (where sold_hit and sale_price is not null) as avg_sale_price
    from hits
    where brand <> 'No brand'
    group by brand
    having count(distinct user_id) filter (where listed_hit or sold_hit) >= (select min_sellers from cfg)
       and count(*) filter (where listed_hit) >= (select min_sellers from cfg)
  ),
  brand_sold as (
    select
      brand,
      count(distinct user_id) as sellers,
      percentile_cont(0.5) within group (order by days_to_sell) as median_days,
      percentile_cont(0.5) within group (order by realization)  as median_real
    from sold_items
    where brand <> 'No brand'
    group by brand
  ),
  -- ── Category deep-dive (k-anonymous), same shape as brands ────────────────
  category_agg as (
    select
      category,
      count(distinct user_id) filter (where listed_hit or sold_hit) as sellers,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      avg(sale_price) filter (where sold_hit and sale_price is not null) as avg_sale_price
    from hits
    where category <> 'Uncategorized'
    group by category
    having count(distinct user_id) filter (where listed_hit or sold_hit) >= (select min_sellers from cfg)
       and count(*) filter (where listed_hit) >= (select min_sellers from cfg)
  ),
  category_sold as (
    select
      category,
      count(distinct user_id) as sellers,
      percentile_cont(0.5) within group (order by days_to_sell) as median_days,
      percentile_cont(0.5) within group (order by realization)  as median_real
    from sold_items
    where category <> 'Uncategorized'
    group by category
  ),
  -- ── Trending categories: last 30d vs prior 30d (k-anonymous) ──────────────
  cat_trend as (
    select
      category,
      count(distinct user_id)
        filter (where sale_date is not null
          and sale_date::date >= current_date - 60) as sellers,
      count(*) filter (where sale_date is not null
        and sale_date::date >= current_date - 30) as sold_recent,
      count(*) filter (where sale_date is not null
        and sale_date::date >= current_date - 60
        and sale_date::date <  current_date - 30) as sold_prev
    from hits
    where category <> 'Uncategorized'
    group by category
    having count(distinct user_id)
      filter (where sale_date is not null
        and sale_date::date >= current_date - 60) >= (select min_sellers from cfg)
  ),
  -- ── Price realization, community-wide (k-anonymous) ───────────────────────
  realization_stats as (
    select
      count(distinct user_id) as sellers,
      count(*) filter (where realization is not null) as sales,
      percentile_cont(0.25) within group (order by realization)  as p25,
      percentile_cont(0.5)  within group (order by realization)  as p50,
      percentile_cont(0.75) within group (order by realization)  as p75,
      percentile_cont(0.5)  within group (order by sale_price)   as median_sale,
      percentile_cont(0.5)  within group (order by list_price)   as median_list
    from sold_items
    where realization is not null
  ),
  -- ── Time-to-sell percentiles, community-wide (k-anonymous) ────────────────
  tts_stats as (
    select
      count(distinct user_id) as sellers,
      count(*) filter (where days_to_sell is not null) as sales,
      percentile_cont(0.25) within group (order by days_to_sell) as p25,
      percentile_cont(0.5)  within group (order by days_to_sell) as p50,
      percentile_cont(0.75) within group (order by days_to_sell) as p75,
      percentile_cont(0.9)  within group (order by days_to_sell) as p90
    from sold_items
    where days_to_sell is not null
  ),
  -- ── Trend series: fixed windows + 12-month monthly buckets ────────────────
  -- These define their OWN time windows (sale_date based), so — like trending
  -- categories — they ignore p_period_start and always reflect the live trend.
  all_sales as (
    select user_id, sale_date::date as sd, sale_price
    from base
    where sale_date is not null
  ),
  win as (
    select
      count(distinct user_id) filter (where sd >= current_date - 30)  as s30_sellers,
      count(*) filter (where sd >= current_date - 30)                 as s30_sold,
      sum(sale_price) filter (where sd >= current_date - 30)          as s30_gmv,
      count(distinct user_id) filter (where sd >= current_date - 90)  as s90_sellers,
      count(*) filter (where sd >= current_date - 90)                 as s90_sold,
      sum(sale_price) filter (where sd >= current_date - 90)          as s90_gmv,
      count(distinct user_id) filter (where sd >= current_date - 365) as s365_sellers,
      count(*) filter (where sd >= current_date - 365)                as s365_sold,
      sum(sale_price) filter (where sd >= current_date - 365)         as s365_gmv
    from all_sales
  ),
  months as (
    select
      to_char(g, 'YYYY-MM') as month,
      g as month_start
    from generate_series(
      date_trunc('month', current_date::timestamp) - interval '11 months',
      date_trunc('month', current_date::timestamp),
      interval '1 month'
    ) g
  ),
  monthly as (
    select
      m.month,
      m.month_start,
      count(distinct s.user_id) as sellers,
      count(s.*) as sold,
      coalesce(sum(s.sale_price), 0) as gmv
    from months m
    left join all_sales s on date_trunc('month', s.sd::timestamp) = m.month_start
    group by m.month, m.month_start
  ),
  -- ── Seller-level sell-through for the you-vs-peers comparison ──────────────
  -- Require a minimum listing volume so a 1-item fluke is not a "rate".
  seller_rates as (
    select
      user_id,
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold,
      (count(*) filter (where sold_hit))::numeric
        / nullif(count(*) filter (where listed_hit), 0) as st
    from hits
    group by user_id
    having count(*) filter (where listed_hit) >= 3
  ),
  caller as (
    select listed, sold, st from seller_rates where user_id = v_owner
  ),
  -- The caller's raw counts, independent of the >= 3 listed floor, so they
  -- always see their own numbers even with thin inventory.
  caller_raw as (
    select
      count(*) filter (where listed_hit) as listed,
      count(*) filter (where sold_hit)   as sold
    from hits
    where user_id = v_owner
  ),
  -- The caller's own time-to-sell / realization medians — always shown (own data).
  caller_sold as (
    select
      percentile_cont(0.5) within group (order by days_to_sell) as median_days,
      percentile_cont(0.5) within group (order by realization)  as median_real,
      count(*) filter (where days_to_sell is not null) as with_days,
      count(*) filter (where realization is not null)  as with_real
    from sold_items
    where user_id = v_owner
  ),
  peers as (
    select st from seller_rates where user_id <> v_owner and st is not null
  ),
  peer_stats as (
    select
      count(*) as n,
      percentile_cont(0.5) within group (order by st) as median
    from peers
  ),
  -- ── US-2235 AC2: how many sellers are actually behind these numbers ───────
  --
  -- The page previously showed medians and percentiles with no sense of scale,
  -- so "the community median" read the same whether it came from 6 sellers or
  -- 600. That is the difference between a curiosity and a number worth sourcing
  -- against, and only one of the two deserves the confidence the UI projected.
  --
  -- Two counts, because they answer different questions: `cohort` is who is in
  -- the current (possibly filtered) view, `total` is the whole platform. A
  -- seller narrowing to one brand needs to see BOTH — "12 of 480 sellers" says
  -- what a bare 12 cannot.
  --
  -- Both pass the same k-anonymity floor. A cohort count below the floor is
  -- returned as null, not as the number: every aggregate is already nulled at
  -- that point, and publishing "3 sellers" alongside them would leak the one
  -- fact the nulls exist to withhold.
  coverage_stats as (
    select
      (select count(distinct user_id) from hits) as cohort_sellers,
      (select count(distinct user_id) from public.inventory_items) as total_sellers
  )
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'minSellers', (select min_sellers from cfg),
      'periodStart', p_period_start,
      'generatedAt', now(),
      -- Echoed back so the client renders what the SERVER actually applied
      -- rather than what it believes it asked for. The two diverge the moment a
      -- filter is added on one side only, and a banner claiming a filter that
      -- never reached the query is worse than no banner.
      'filters', jsonb_build_object(
        'brand', nullif(trim(coalesce(p_brand, '')), ''),
        'category', nullif(trim(coalesce(p_category, '')), ''),
        'size', nullif(trim(coalesce(p_size, '')), ''),
        'priceMin', p_price_min,
        'priceMax', p_price_max
      ),
      'coverage', (
        select jsonb_build_object(
          'cohortSellers', case when cv.cohort_sellers >= (select min_sellers from cfg)
            then cv.cohort_sellers else null end,
          'totalSellers', case when cv.total_sellers >= (select min_sellers from cfg)
            then cv.total_sellers else null end,
          -- So the UI can say "too few to show" without inferring it from a
          -- null it cannot distinguish from "nobody has sold anything yet".
          'belowFloor', cv.cohort_sellers < (select min_sellers from cfg)
        )
        from coverage_stats cv
      )
    ),
    'topBrands', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'brand', ba.brand,
          'sellers', ba.sellers,
          'listed', ba.listed,
          'sold', ba.sold,
          'sellThrough', case when ba.listed > 0 then ba.sold::numeric / ba.listed else null end,
          'avgSalePrice', round(ba.avg_sale_price::numeric, 2),
          -- Per-brand derived medians only when the brand's SOLD cohort itself is
          -- k-anonymous (distinct sellers who sold it >= floor).
          'medianRealization', case when bs.sellers >= (select min_sellers from cfg)
            then round(bs.median_real::numeric, 4) else null end,
          'medianDaysToSell', case when bs.sellers >= (select min_sellers from cfg)
            then round(bs.median_days::numeric, 1) else null end
        )
        order by case when ba.listed > 0 then ba.sold::numeric / ba.listed else 0 end desc,
          ba.sold desc
      )
      from brand_agg ba
      left join brand_sold bs on bs.brand = ba.brand
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'category', ca.category,
          'sellers', ca.sellers,
          'listed', ca.listed,
          'sold', ca.sold,
          'sellThrough', case when ca.listed > 0 then ca.sold::numeric / ca.listed else null end,
          'avgSalePrice', round(ca.avg_sale_price::numeric, 2),
          'medianRealization', case when cs.sellers >= (select min_sellers from cfg)
            then round(cs.median_real::numeric, 4) else null end,
          'medianDaysToSell', case when cs.sellers >= (select min_sellers from cfg)
            then round(cs.median_days::numeric, 1) else null end
        )
        order by case when ca.listed > 0 then ca.sold::numeric / ca.listed else 0 end desc,
          ca.sold desc
      )
      from category_agg ca
      left join category_sold cs on cs.category = ca.category
    ), '[]'::jsonb),
    'trendingCategories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'category', category,
          'sellers', sellers,
          'soldRecent', sold_recent,
          'soldPrevious', sold_prev,
          'growth', case when sold_prev > 0
            then (sold_recent - sold_prev)::numeric / sold_prev else null end
        )
        order by sold_recent desc, sold_prev desc
      )
      from cat_trend
    ), '[]'::jsonb),
    -- Overall price realization (sale vs list). Null until the cohort is k-anon.
    'priceRealization', (
      select case when rs.sellers >= (select min_sellers from cfg) then jsonb_build_object(
        'sellers', rs.sellers,
        'sales', rs.sales,
        'medianRatio', round(rs.p50::numeric, 4),
        'p25Ratio', round(rs.p25::numeric, 4),
        'p75Ratio', round(rs.p75::numeric, 4),
        'medianSalePrice', round(rs.median_sale::numeric, 2),
        'medianListPrice', round(rs.median_list::numeric, 2)
      ) else null end
      from realization_stats rs
    ),
    -- Time-to-sell distribution (days). Null until the cohort is k-anon.
    'timeToSell', (
      select case when ts.sellers >= (select min_sellers from cfg) then jsonb_build_object(
        'sellers', ts.sellers,
        'sales', ts.sales,
        'p25', round(ts.p25::numeric, 1),
        'p50', round(ts.p50::numeric, 1),
        'p75', round(ts.p75::numeric, 1),
        'p90', round(ts.p90::numeric, 1)
      ) else null end
      from tts_stats ts
    ),
    -- Trend windows + monthly series. Each window / month with too few sellers is
    -- nulled out (kept in the series so the chart shows a gap, never a count < floor).
    'trends', jsonb_build_object(
      'windows', (
        select jsonb_build_object(
          'd30', case when w.s30_sellers >= (select min_sellers from cfg)
            then jsonb_build_object('sellers', w.s30_sellers, 'sold', w.s30_sold,
              'gmv', round(coalesce(w.s30_gmv, 0)::numeric, 2)) else null end,
          'd90', case when w.s90_sellers >= (select min_sellers from cfg)
            then jsonb_build_object('sellers', w.s90_sellers, 'sold', w.s90_sold,
              'gmv', round(coalesce(w.s90_gmv, 0)::numeric, 2)) else null end,
          'd365', case when w.s365_sellers >= (select min_sellers from cfg)
            then jsonb_build_object('sellers', w.s365_sellers, 'sold', w.s365_sold,
              'gmv', round(coalesce(w.s365_gmv, 0)::numeric, 2)) else null end
        )
        from win w
      ),
      'monthly', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'month', mo.month,
            'sellers', case when mo.sellers >= (select min_sellers from cfg) then mo.sellers else null end,
            'sold', case when mo.sellers >= (select min_sellers from cfg) then mo.sold else null end,
            'gmv', case when mo.sellers >= (select min_sellers from cfg) then round(mo.gmv::numeric, 2) else null end
          )
          order by mo.month_start
        )
        from monthly mo
      ), '[]'::jsonb)
    ),
    'you', jsonb_build_object(
      'listed', (select listed from caller_raw),
      'sold', (select sold from caller_raw),
      'sellThrough', (
        select case when listed > 0 then sold::numeric / listed else null end
        from caller_raw
      ),
      'medianDaysToSell', (
        select case when with_days > 0 then round(median_days::numeric, 1) else null end
        from caller_sold
      ),
      'medianRealization', (
        select case when with_real > 0 then round(median_real::numeric, 4) else null end
        from caller_sold
      ),
      -- Peer comparison is itself k-anonymous: shown only when >= floor peers have
      -- a rate, and exposes only cohort statistics (median, the caller's percentile
      -- among peers) — never an individual peer's value.
      'peerComparison', (
        select case when ps.n >= (select min_sellers from cfg) then jsonb_build_object(
          'peerCount', ps.n,
          'peerMedianSellThrough', round(ps.median::numeric, 4),
          'yourSellThrough', (select st from caller),
          'percentile', case
            when (select st from caller) is not null then (
              select round(avg(case when p.st <= (select st from caller)
                then 1.0 else 0.0 end)::numeric, 2)
              from peers p
            )
            else null
          end
        ) else null end
        from peer_stats ps
      )
    )
  )
  );
end;
$fn$;

comment on function public.community_benchmarks_v2(date, text, text, text, numeric, numeric, uuid) is
  '00836: community_benchmarks (00569/00640) with the you block for ONE workspace '
  '(p_owner_id, NULL = the caller), 42501 for a non-member. SECURITY DEFINER, body-guarded; '
  'the cohort and its k-anonymity floors are v1''s. The web calls this; iOS and Android call v1.';

grant execute on function public.community_benchmarks_v2(date, text, text, text, numeric, numeric, uuid) to authenticated;
grant execute on function public.community_benchmarks_v2(date, text, text, text, numeric, numeric, uuid) to service_role;

-- ── flipdesk_listing_performance_summary ───────────────────────────────────
drop function if exists public.flipdesk_listing_performance_summary();

create or replace function public.flipdesk_listing_performance_summary(
  -- 00836: the workspace on screen. NULL = the caller's own listings.
  p_owner_id uuid default null
)
returns table (
  total_listings bigint,
  total_views    bigint,
  avg_ctr        numeric,
  stale_count    bigint,
  last_synced_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $fn$
#variable_conflict use_column
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  if auth.role() is not null and auth.role() not in ('service_role', 'authenticated') then
    raise exception 'flipdesk_listing_performance_summary: sign-in required' using errcode = '42501';
  end if;
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'flipdesk_listing_performance_summary: not a member of that workspace'
      using errcode = '42501';
  end if;

  return query
  SELECT
    count(*)::bigint,
    coalesce(sum(coalesce(l.views_total, 0)), 0)::bigint,
    -- AVG over the rows that HAVE a rate. avg() already skips NULLs, which is
    -- the same rule the client used: a listing eBay has not reported a CTR for
    -- must not be averaged in as a zero, or a fresh catalog reads as 0% CTR.
    avg(l.click_through_rate),
    count(*) FILTER (
      WHERE coalesce(l.views_total, 0) = 0
        AND l.listed_at IS NOT NULL
        AND l.listed_at <= now() - interval '14 days'
    )::bigint,
    max(l.last_metrics_synced_at)
  FROM public.listings l
  -- 00836: one workspace.
  WHERE l.user_id = v_owner
    AND l.platform = 'ebay'
    AND l.listing_status = 'active';
end;
$fn$;

comment on function public.flipdesk_listing_performance_summary(uuid) is
  'US-2233: KPI tiles for Listing Performance. SECURITY INVOKER. 00836: one workspace '
  '(p_owner_id, NULL = the caller''s own), 42501 for a non-member or anon.';

grant execute on function public.flipdesk_listing_performance_summary(uuid) to authenticated;
grant execute on function public.flipdesk_listing_performance_summary(uuid) to service_role;

-- ── flipdesk_listing_performance_page ──────────────────────────────────────
drop function if exists public.flipdesk_listing_performance_page(text, integer, text, boolean, integer, integer);

create or replace function public.flipdesk_listing_performance_page(
  p_search       text    default null,
  p_no_view_days integer default 0,
  p_sort         text    default 'views_total',
  p_desc         boolean default true,
  p_limit        integer default 50,
  p_offset       integer default 0,
  -- 00836: the workspace on screen. NULL = the caller's own listings.
  p_owner_id     uuid    default null
)
returns table (
  id                     uuid,
  inventory_item_id      uuid,
  title                  text,
  listing_url            text,
  listing_price          numeric,
  listed_at              timestamptz,
  views_total            integer,
  watchers_count         integer,
  impressions_7d         integer,
  click_through_rate     numeric,
  last_metrics_synced_at timestamptz,
  view_trend_7d          jsonb,
  total_count            bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $fn$
#variable_conflict use_column
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
begin
  if auth.role() is not null and auth.role() not in ('service_role', 'authenticated') then
    raise exception 'flipdesk_listing_performance_page: sign-in required' using errcode = '42501';
  end if;
  if p_owner_id is not null
     and auth.role() is distinct from 'service_role'
     and not coalesce(public.is_workspace_member(p_owner_id), false) then
    raise exception 'flipdesk_listing_performance_page: not a member of that workspace'
      using errcode = '42501';
  end if;

  return query
  WITH base AS (
    SELECT
      l.id,
      l.inventory_item_id,
      -- The title fallback the client used to do in a second query: blank
      -- listing_title resolves to the inventory item's title. Doing it here is
      -- what makes SEARCH correct — a client-side search over listing_title
      -- alone silently missed every listing whose title came from the item.
      nullif(btrim(coalesce(l.listing_title, '')), '') AS listing_title,
      i.title AS item_title,
      l.listing_url,
      l.listing_price,
      l.listed_at,
      l.views_total,
      l.watchers_count,
      l.impressions_7d,
      l.click_through_rate,
      l.last_metrics_synced_at,
      l.view_trend_7d
    FROM public.listings l
    LEFT JOIN public.inventory_items i ON i.id = l.inventory_item_id
    -- 00836: one workspace, before the search, the count and the page.
    WHERE l.user_id = v_owner
      AND l.platform = 'ebay'
      AND l.listing_status = 'active'
  ),
  resolved AS (
    SELECT
      b.*,
      coalesce(b.listing_title, b.item_title, '') AS resolved_title
    FROM base b
  ),
  filtered AS (
    SELECT r.*
    FROM resolved r
    WHERE (
        p_search IS NULL
        OR btrim(p_search) = ''
        -- ESCAPED: a seller searching for a title containing % or _ must not
        -- get a wildcard match. `\` is the default LIKE escape character.
        OR r.resolved_title ILIKE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
      AND (
        coalesce(p_no_view_days, 0) <= 0
        OR (
          coalesce(r.views_total, 0) = 0
          AND r.listed_at IS NOT NULL
          AND r.listed_at <= now() - make_interval(days => p_no_view_days)
        )
      )
  )
  SELECT
    f.id,
    f.inventory_item_id,
    f.resolved_title,
    f.listing_url,
    f.listing_price,
    f.listed_at,
    f.views_total,
    f.watchers_count,
    f.impressions_7d,
    f.click_through_rate,
    f.last_metrics_synced_at,
    f.view_trend_7d,
    count(*) OVER ()::bigint AS total_count
  FROM filtered f
  ORDER BY
    -- NULLS LAST in both directions: a listing eBay has never reported on is
    -- missing data, not a top or bottom performer, and floating it to the head
    -- of a "most viewed" report would be a wrong answer rather than an empty one.
    -- p_sort <> 'title' guards the ELSE below: without it a title sort would
    -- still order by views_total first and use the title only as a tiebreak.
    CASE WHEN p_desc AND p_sort <> 'title' THEN
      CASE p_sort
        WHEN 'watchers_count'     THEN f.watchers_count::numeric
        WHEN 'impressions_7d'     THEN f.impressions_7d::numeric
        WHEN 'click_through_rate' THEN f.click_through_rate
        WHEN 'listing_price'      THEN f.listing_price
        WHEN 'listed_at'          THEN extract(epoch FROM f.listed_at)
        ELSE f.views_total::numeric
      END
    END DESC NULLS LAST,
    CASE WHEN NOT p_desc AND p_sort <> 'title' THEN
      CASE p_sort
        WHEN 'watchers_count'     THEN f.watchers_count::numeric
        WHEN 'impressions_7d'     THEN f.impressions_7d::numeric
        WHEN 'click_through_rate' THEN f.click_through_rate
        WHEN 'listing_price'      THEN f.listing_price
        WHEN 'listed_at'          THEN extract(epoch FROM f.listed_at)
        ELSE f.views_total::numeric
      END
    END ASC NULLS LAST,
    -- Title sorts as TEXT, which cannot share the numeric CASE above without
    -- casting a title to a number. Kept as its own pair so the numeric columns
    -- stay numeric — sorting views as text would put 9 above 120.
    CASE WHEN p_sort = 'title' AND p_desc THEN lower(f.resolved_title) END DESC NULLS LAST,
    CASE WHEN p_sort = 'title' AND NOT p_desc THEN lower(f.resolved_title) END ASC NULLS LAST,
    -- Deterministic tiebreak. Without it two rows with equal views can swap
    -- between pages, so paging would show one twice and skip another.
    f.id
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  OFFSET greatest(0, coalesce(p_offset, 0));
end;
$fn$;

comment on function public.flipdesk_listing_performance_page(text, integer, text, boolean, integer, integer, uuid) is
  'US-2233: one searched, sorted, paged page of Listing Performance. SECURITY INVOKER. 00836: '
  'one workspace (p_owner_id, NULL = the caller''s own), 42501 for a non-member or anon.';

grant execute on function public.flipdesk_listing_performance_page(text, integer, text, boolean, integer, integer, uuid) to authenticated;
grant execute on function public.flipdesk_listing_performance_page(text, integer, text, boolean, integer, integer, uuid) to service_role;

insert into public.applied_migrations (version) values ('00836') on conflict do nothing;
