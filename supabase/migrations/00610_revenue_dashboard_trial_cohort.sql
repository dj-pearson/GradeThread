-- US-2663: revenue_dashboard has never worked, and the break was hiding a leak.
--
-- TWO CHANGES, and they must ship together. Everything else in this file is the
-- live 00608 definition carried through byte-for-byte.
--
-- ── 1. The trial cohort keyed on a column that does not exist ───────────────
--
-- The `trial` branch selected public.users.trial_started_at. THAT COLUMN HAS
-- NEVER EXISTED on that table -- no migration ever added or dropped it, and the
-- name lives on a different table (ai_prompt_versions.trial_started_at, 00155).
-- The `trial` key is built unconditionally into the returned jsonb, so every
-- call since 00215 raised 42703; no parameter combination avoids it. Confirmed
-- by CALLING it, not by reading it.
--
-- THE DECISION (AC1 said not to guess). The metric is "trials STARTED in the
-- window", so it needs a start instant, and the two candidates are not
-- equivalent:
--
--   (a) trial_ends_at - interval '14 days'. REJECTED. trial_ends_at is an END
--       date that MOVES after signup -- routes/webhooks.ts:700 writes it from
--       the Stripe subscription's trial_end, routes/admin-billing.ts:776 lets
--       an admin set it outright. Deriving a start from it means extending a
--       trial silently RELOCATES that user into a different historical cohort,
--       changing a number already reported. It also bakes the trial length into
--       the metric, so changing the offer would rewrite history.
--
--   (b) created_at, filtered to users who were actually given a trial. TAKEN.
--       handle_new_user sets trial_ends_at = now() + interval '14 days' at
--       insert, so created_at IS the trial start, by construction, and it never
--       moves.
--
-- `trial_ends_at is not null` is the direct translation of the original
-- `trial_started_at is not null`: buyer-only signups get NULL and no trial
-- (handle_new_user's CASE), and must stay out of the denominator.
--
-- KNOWN IMPRECISION, stated rather than hidden: a user who signed up without a
-- trial and was granted one LATER by Stripe lands in their SIGNUP window rather
-- than their trial window. Rare, and the same direction of error the original
-- intended; (a) is wrong in a worse way because it is retroactive.
--
-- ── 2. The guard let anon through, and the bug was the only thing stopping it ─
--
-- The authorization check read `if auth.uid() is not null and not
-- public.is_admin()`, with a comment asserting "anon can't reach this --
-- execute is not granted to it". Both halves are false together, which is the
-- dangerous combination:
--
--   * anon DOES have execute. CREATE FUNCTION grants it to PUBLIC and every
--     role is a member of PUBLIC, so the REVOKE ... FROM anon pattern this repo
--     used 13 times never removed it (US-2666 -- proven three ways, and six
--     functions are affected).
--   * anon's auth.uid() IS null, so the guard's own condition passed it
--     straight through.
--
-- Which means fixing change 1 alone would have turned a function that errors
-- into one that hands a full revenue document -- MRR, ARR, ARPU, plan mix,
-- churn -- to anyone holding the public anon key. The 42703 was the only thing
-- standing there. So the guard is replaced with the ALLOWLIST form
-- admin_revenue_metrics already uses, in the same migration.
--
-- ── Why there is no REVOKE in this file ─────────────────────────────────────
-- Tightening the grant looks like the obvious fix and is not available: a
-- DENIED call from anon or authenticated SEGFAULTS this Postgres image
-- (US-2403), which is why 00527 is a DO NOT APPLY. A body check raises an
-- ordinary error instead, so it arms nothing. This is US-2282's remedy applied
-- to one function.

CREATE OR REPLACE FUNCTION public.revenue_dashboard(p_start timestamp with time zone, p_end timestamp with time zone, p_granularity text DEFAULT 'day'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result      jsonb;
  v_gran      text;
  v_mrr_cents numeric;
begin
  -- US-2663 + US-2666: an ALLOWLIST, matching admin_revenue_metrics.
  --
  -- This used to read `if auth.uid() is not null and not public.is_admin()`,
  -- with the comment "anon can't reach this -- execute is not granted to it".
  -- Both halves were wrong together. anon HAS execute: CREATE FUNCTION grants
  -- it to PUBLIC and every role belongs to PUBLIC, so the REVOKE ... FROM anon
  -- pattern used elsewhere in this repo never removed it (US-2666, proven).
  -- And anon's auth.uid() IS null, so the guard's own condition waved it
  -- straight through to a full revenue document.
  --
  -- Nobody noticed because the 42703 below masked it: the function raised
  -- before returning anything. Fixing the column removes that accidental
  -- protection, so the guard has to be correct in the SAME migration.
  if not (auth.role() = 'service_role' or public.is_admin()) then
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
    and u.flipdesk_plan <> 'free'
    and u.billing_environment is distinct from 'sandbox';

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
          and billing_environment is distinct from 'sandbox'
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
          and billing_environment is distinct from 'sandbox'
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
            and u.billing_environment is distinct from 'sandbox'
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
        -- US-2663: this keyed on a column that has never existed on
        -- public.users. created_at IS the trial start by construction --
        -- handle_new_user sets trial_ends_at = now() + interval '14 days' at
        -- insert -- and unlike trial_ends_at it never moves afterwards.
        where trial_ends_at is not null
          and created_at >= p_start and created_at < p_end
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
$function$;

insert into public.applied_migrations (version) values ('00610') on conflict do nothing;
