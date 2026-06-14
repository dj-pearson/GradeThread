-- US-891: Revenue & MRR analytics dashboard.
--
-- An operator-facing MRR/ARR rollup so business health is visible without
-- exporting Stripe. Everything is aggregated SERVER-SIDE in one jsonb document
-- (no per-row math in the browser): a point-in-time MRR/ARR snapshot, plan mix,
-- event-based MRR movement (new / churned / expansion / contraction) over the
-- requested window, to-date trial-cohort conversion, and one-time credit-pack
-- revenue — plus a daily/weekly time series for charting.
--
-- Pricing is single-sourced from the data-driven tables (NOT hardcoded here):
--   * subscription MRR  ← pricing_plans (00166): price_monthly_cents /
--     price_yearly_cents, yearly normalized to monthly.
--   * credit-pack price ← pricing_config (00209): credit_pack rows, matched to a
--     ledger row's `delta` (= pack size = credits granted).
--
-- RECONCILIATION TOLERANCE (AC4): Stripe remains the source of truth for actual
-- cash collected. This dashboard's figures are derived from our subscription
-- columns + audit events and will differ from Stripe by, at minimum:
--   * MRR movement uses each plan's MONTHLY list price as the per-event proxy —
--     flipdesk_subscription_events does not record the billing interval, so an
--     annual upgrade is counted at its monthly-equivalent list price, and
--     coupons / proration / tax are not reflected.
--   * Credit-pack revenue is GROSS of refunds and disputes, and uses the catalog
--     price (pricing_config) rather than the exact Stripe charge.
-- Treat these as directional operating metrics; reconcile cash against Stripe.
--
-- Access: SECURITY DEFINER (reads cross-tenant data, so it can't run under the
-- caller's RLS). The guard mirrors the admin-RPC convention but also permits the
-- service-role caller (the admin edge route, which has already enforced admin +
-- AAL2 in middleware): an authenticated end-user must be an admin; a call with
-- no JWT subject (service_role) is allowed, and anon is never granted execute.

create or replace function public.revenue_dashboard(
  p_start       timestamptz,
  p_end         timestamptz,
  p_granularity text default 'day'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result      jsonb;
  v_gran      text;
  v_mrr_cents numeric;
begin
  -- Authenticated end-users must be admins; the service-role edge (auth.uid()
  -- null) passes. anon can't reach this — execute is not granted to it.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'revenue_dashboard: admin role required'
      using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'revenue_dashboard: invalid period window (start must precede end)'
      using errcode = '22023';
  end if;

  -- Only daily or weekly buckets are supported; anything else falls back to day.
  v_gran := lower(coalesce(p_granularity, 'day'));
  if v_gran not in ('day', 'week') then
    v_gran := 'day';
  end if;

  -- ── Point-in-time MRR (active paid subs, priced from pricing_plans) ──
  -- trialing is NOT counted toward MRR (no charge yet); free is not a paid tier.
  select coalesce(sum(
    case when u.flipdesk_interval = 'yearly'
      then pp.price_yearly_cents / 12.0
      else pp.price_monthly_cents
    end
  ), 0)
  into v_mrr_cents
  from public.users u
  join public.pricing_plans pp on pp.key = u.flipdesk_plan::text
  where u.subscription_status in ('active', 'past_due')
    and u.flipdesk_plan <> 'free';

  select jsonb_build_object(
    'period', jsonb_build_object(
      'start', p_start,
      'end', p_end,
      'granularity', v_gran
    ),

    -- ── Current snapshot ──
    'current', jsonb_build_object(
      'mrrCents', round(v_mrr_cents),
      'arrCents', round(v_mrr_cents * 12),
      'activePaid', (
        select count(*)::int from public.users
        where subscription_status in ('active', 'past_due') and flipdesk_plan <> 'free'
      ),
      'trialing', (
        select count(*)::int from public.users where subscription_status = 'trialing'
      ),
      'pastDue', (
        select count(*)::int from public.users where subscription_status = 'past_due'
      ),
      'arpuCents', (
        select case when count(*) > 0 then round(v_mrr_cents / count(*)) else 0 end
        from public.users
        where subscription_status in ('active', 'past_due') and flipdesk_plan <> 'free'
      ),
      -- Plan mix: active paid subs by (plan, interval) with each bucket's MRR.
      'byPlan', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'plan', plan, 'interval', intv, 'count', cnt, 'mrrCents', mrr
        ) order by plan, intv), '[]'::jsonb)
        from (
          select
            u.flipdesk_plan::text as plan,
            coalesce(u.flipdesk_interval::text, 'monthly') as intv,
            count(*)::int as cnt,
            round(sum(case when u.flipdesk_interval = 'yearly'
              then pp.price_yearly_cents / 12.0 else pp.price_monthly_cents end)) as mrr
          from public.users u
          join public.pricing_plans pp on pp.key = u.flipdesk_plan::text
          where u.subscription_status in ('active', 'past_due') and u.flipdesk_plan <> 'free'
          group by u.flipdesk_plan, u.flipdesk_interval
        ) s
      )
    ),

    -- ── MRR movement over the window (event-based; monthly-price proxy) ──
    'movement', (
      with ev as (
        select
          e.event_type,
          e.from_plan::text as from_plan,
          e.to_plan::text   as to_plan,
          coalesce(fp.price_monthly_cents, 0) as from_cents,
          coalesce(tp.price_monthly_cents, 0) as to_cents
        from public.flipdesk_subscription_events e
        left join public.pricing_plans fp on fp.key = e.from_plan::text
        left join public.pricing_plans tp on tp.key = e.to_plan::text
        where e.created_at >= p_start and e.created_at < p_end
          and e.event_type in (
            'customer.subscription.created',
            'customer.subscription.updated',
            'customer.subscription.deleted'
          )
      )
      select jsonb_build_object(
        'newCount', (
          select count(*)::int from ev
          where event_type = 'customer.subscription.created'
            and to_plan is not null and to_plan <> 'free'
            and (from_plan is null or from_plan = 'free')
        ),
        'newMrrCents', (
          select coalesce(sum(to_cents), 0)::bigint from ev
          where event_type = 'customer.subscription.created'
            and to_plan is not null and to_plan <> 'free'
            and (from_plan is null or from_plan = 'free')
        ),
        'churnedCount', (
          select count(*)::int from ev
          where event_type = 'customer.subscription.deleted'
            and from_plan is not null and from_plan <> 'free'
        ),
        'churnedMrrCents', (
          select coalesce(sum(from_cents), 0)::bigint from ev
          where event_type = 'customer.subscription.deleted'
            and from_plan is not null and from_plan <> 'free'
        ),
        'expansionMrrCents', (
          select coalesce(sum(to_cents - from_cents), 0)::bigint from ev
          where event_type in ('customer.subscription.updated', 'customer.subscription.created')
            and from_plan is not null and from_plan <> 'free'
            and to_plan is not null and to_plan <> 'free'
            and to_cents > from_cents
        ),
        'contractionMrrCents', (
          select coalesce(sum(from_cents - to_cents), 0)::bigint from ev
          where event_type in ('customer.subscription.updated', 'customer.subscription.created')
            and from_plan is not null and from_plan <> 'free'
            and to_plan is not null and to_plan <> 'free'
            and to_cents < from_cents
        )
      )
    ),

    -- ── Trial-to-paid (cohort started in window, conversion measured to-date) ──
    'trial', (
      with started as (
        select subscription_status, flipdesk_plan
        from public.users
        where trial_started_at is not null
          and trial_started_at >= p_start and trial_started_at < p_end
      )
      select jsonb_build_object(
        'startedInPeriod', (select count(*)::int from started),
        'convertedFromCohort', (
          select count(*)::int from started
          where subscription_status in ('active', 'past_due') and flipdesk_plan <> 'free'
        )
      )
    ),

    -- ── One-time credit-pack revenue (gross; priced from pricing_config) ──
    'credits', (
      select jsonb_build_object(
        'packRevenueCents', coalesce(sum(pc.price_cents), 0)::bigint,
        'packCount', count(t.id)::int
      )
      from public.grade_credit_transactions t
      left join public.pricing_config pc
        on pc.kind = 'credit_pack' and pc.credits = t.delta
      where t.reason = 'pack_purchase'
        and t.created_at >= p_start and t.created_at < p_end
    ),

    -- ── Daily / weekly time series for charts ──
    'timeSeries', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'start', b.bucket,
        'newCount', coalesce(subs.new_count, 0),
        'churnedCount', coalesce(subs.churned_count, 0),
        'packRevenueCents', coalesce(cr.pack_revenue, 0),
        'packCount', coalesce(cr.pack_count, 0)
      ) order by b.bucket), '[]'::jsonb)
      from generate_series(
        date_trunc(v_gran, p_start),
        date_trunc(v_gran, p_end),
        ('1 ' || v_gran)::interval
      ) as b(bucket)
      left join lateral (
        select
          count(*) filter (
            where e.event_type = 'customer.subscription.created'
              and e.to_plan is not null and e.to_plan::text <> 'free'
          ) as new_count,
          count(*) filter (
            where e.event_type = 'customer.subscription.deleted'
              and e.from_plan is not null and e.from_plan::text <> 'free'
          ) as churned_count
        from public.flipdesk_subscription_events e
        where e.created_at >= b.bucket
          and e.created_at < b.bucket + ('1 ' || v_gran)::interval
      ) subs on true
      left join lateral (
        select
          coalesce(sum(pc.price_cents), 0) as pack_revenue,
          count(t.id) as pack_count
        from public.grade_credit_transactions t
        left join public.pricing_config pc
          on pc.kind = 'credit_pack' and pc.credits = t.delta
        where t.reason = 'pack_purchase'
          and t.created_at >= b.bucket
          and t.created_at < b.bucket + ('1 ' || v_gran)::interval
      ) cr on true
    )
  ) into result;

  return result;
end;
$$;

comment on function public.revenue_dashboard(timestamptz, timestamptz, text) is
  'US-891: server-side MRR/ARR rollup for the admin revenue dashboard — '
  'point-in-time MRR/ARR + plan mix (priced from pricing_plans), event-based MRR '
  'movement, to-date trial-cohort conversion, gross credit-pack revenue '
  '(priced from pricing_config), and a daily/weekly time series, as one jsonb '
  'document. SECURITY DEFINER (cross-tenant); admin or service-role only. '
  'Stripe remains the source of truth for actual cash — see migration header for '
  'the documented reconciliation tolerance.';

-- Execute: authenticated (the in-function is_admin guard enforces admin) and
-- service_role (the admin edge route). Deliberately NOT granted to anon.
grant execute on function public.revenue_dashboard(timestamptz, timestamptz, text) to authenticated;
grant execute on function public.revenue_dashboard(timestamptz, timestamptz, text) to service_role;
