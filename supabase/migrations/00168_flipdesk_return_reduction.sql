-- US-595: Grade-backed return-reduction intelligence.
--
-- US-459 added the *mechanical* return signal: sales.status can now be
-- 'refunded' (buyer returned / fully refunded) or 'cancelled' (order never
-- fulfilled), surfaced on items_full as sale_status (migration 00111). What was
-- missing is the seller-ROI story — tying those returns back to the item's
-- condition grade so a seller can see, in their OWN history, that lower-graded
-- items come back more often. That is the concrete grading-ROI argument.
--
-- This RPC aggregates the seller's fulfilled sales into grade bands and reports
-- the return rate per band, plus graded-vs-ungraded and overall rollups. The
-- client turns these into the "items graded <=6 return Nx more" headline and the
-- condition-guarantee surface.
--
-- METHODOLOGY (kept deliberately simple and honest, mirrored in the UI):
--   * "fulfilled" sale = a sale that actually shipped, i.e. sale_status in
--     ('completed','refunded'). Cancelled/pending orders never shipped, so they
--     can't be "returned" and are excluded from both numerator and denominator.
--   * "return" = sale_status = 'refunded' (the eBay sync stamps this from a
--     FULLY_REFUNDED order — the closest mechanical proxy we have for a
--     buyer-side return / INAD).
--   * return rate = returns / fulfilled, per grade band.
--   * p_period_start (yyyy-mm-dd, null = all time) filters on the sale date.
--   * Grade bands use items_full.grade_value (1.0-10.0; null = ungraded).
--   Sample-size trust (a band needs enough fulfilled sales before its rate means
--   anything) is applied client-side so the threshold lives next to the copy.
--
-- SECURITY INVOKER: reads items_full, a security_invoker view, so the caller's
-- RLS (owner + workspace-member visibility) applies exactly as elsewhere. No
-- explicit user_id scoping needed (same model as flipdesk_sell_through, 00148).

BEGIN;

create or replace function public.flipdesk_return_reduction(
  p_period_start date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
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
    where sale_status in ('completed', 'refunded')
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
  from rollup r;
$$;

grant execute on function public.flipdesk_return_reduction(date) to authenticated;
grant execute on function public.flipdesk_return_reduction(date) to service_role;

COMMIT;
