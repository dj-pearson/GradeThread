-- US-946: Trial-conversion drip analytics — schema + read-only rollup RPC.
--
-- The Trial Conversion Drip Engine epic (US-908..US-945) sends a ~28-day
-- sequence (14d in-trial + 14d post-trial win-back) to no-card trialists and
-- exits instantly on conversion (customer.subscription.created). This migration
-- lays down the three durable tables that engine writes to — enrollments, sends,
-- and the conversion attribution ledger (US-944) — and the server-side
-- `drip_analytics` rollup that powers the operator funnel/ROI dashboard (US-946).
--
-- Definitions (documented so the dashboard numbers are unambiguous and tie back
-- to the attribution ledger):
--   • enrolled        — a row in drip_enrollments for the campaign in-window.
--   • sent/opened/clicked — per (enrollment, step) engagement on drip_sends,
--                       mirroring US-913 open/click tracking.
--   • converted       — a drip_attributions row (one per enrollment that became
--                       paid while enrolled); conversion = the Stripe
--                       customer.subscription.created the engine observed.
--   • days-to-convert — converted_at − coalesce(trial_started_at, enrolled_at).
--   • in-trial vs win-back — attribution.phase; the engine stamps which half of
--                       the sequence was active at conversion.
--   • attributed MRR  — attribution.mrr_cents (the plan's monthly recurring
--                       value at conversion). Stripe stays source of truth;
--                       stripe_reconciled flags rows confirmed against Stripe so
--                       the dashboard can show a reconciliation rate + tolerance.
--
-- All tables are service-role only (written by the edge engine); the dashboard
-- reads exclusively through the aggregating RPC, never the raw rows.

BEGIN;

-- ── Enrollments: one row per user per campaign run ──────────────────────────
create table if not exists public.drip_enrollments (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  campaign         text not null default 'trial_conversion',
  variant          text,                         -- US-927/928 A/B arm
  incentive_enabled boolean not null default false, -- incentive-on vs -off arm
  signup_week      date,                         -- date_trunc('week', signup) cohort
  enrolled_at      timestamptz not null default now(),
  trial_started_at timestamptz,
  converted_at     timestamptz,                  -- mirrors attribution; denormalized for exit
  exited_at        timestamptz,
  exit_reason      text check (exit_reason is null or exit_reason in
                     ('converted', 'trial_expired', 'unsubscribed', 'completed', 'suppressed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.drip_enrollments is
  'US-946: trial-conversion drip enrollments (one per user per campaign run).';

create index if not exists drip_enrollments_campaign_idx
  on public.drip_enrollments (campaign, enrolled_at);
create index if not exists drip_enrollments_user_idx
  on public.drip_enrollments (user_id);

-- ── Sends: one row per (enrollment, step) — the funnel grain ────────────────
create table if not exists public.drip_sends (
  id             uuid primary key default gen_random_uuid(),
  enrollment_id  uuid not null references public.drip_enrollments(id) on delete cascade,
  campaign       text not null default 'trial_conversion',
  step           int  not null,                  -- ordinal position in the sequence
  phase          text not null default 'in_trial'
                   check (phase in ('in_trial', 'win_back')),
  variant        text,
  sent_at        timestamptz,
  opened_at      timestamptz,                    -- US-913 open tracking
  clicked_at     timestamptz,                    -- US-913 click tracking
  unsubscribed   boolean not null default false, -- US-914 suppression triggered here
  created_at     timestamptz not null default now()
);

comment on table public.drip_sends is
  'US-946: per-step drip send + engagement (sent/opened/clicked/unsub).';

create index if not exists drip_sends_enrollment_idx
  on public.drip_sends (enrollment_id);
create index if not exists drip_sends_campaign_step_idx
  on public.drip_sends (campaign, step);

-- ── Attribution ledger (US-944): one row per converted enrollment ───────────
create table if not exists public.drip_attributions (
  id                   uuid primary key default gen_random_uuid(),
  enrollment_id        uuid not null references public.drip_enrollments(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  campaign             text not null default 'trial_conversion',
  step                 int,                        -- step active at conversion
  phase                text not null default 'in_trial'
                         check (phase in ('in_trial', 'win_back')),
  variant              text,
  incentive_enabled    boolean not null default false,
  mrr_cents            int  not null default 0,
  stripe_subscription_id text,
  stripe_reconciled    boolean not null default false, -- confirmed against Stripe
  converted_at         timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  unique (enrollment_id)
);

comment on table public.drip_attributions is
  'US-944/946: conversion attribution ledger for the trial drip (one per enrollment).';

create index if not exists drip_attributions_campaign_idx
  on public.drip_attributions (campaign, converted_at);

-- updated_at maintenance for enrollments (project-wide trigger convention).
create or replace function public.set_drip_enrollments_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_drip_enrollments_updated_at on public.drip_enrollments;
create trigger trg_drip_enrollments_updated_at
  before update on public.drip_enrollments
  for each row execute function public.set_drip_enrollments_updated_at();

-- Service-role only — the edge engine writes; nothing client-facing.
alter table public.drip_enrollments  enable row level security;
alter table public.drip_sends        enable row level security;
alter table public.drip_attributions enable row level security;
revoke all on public.drip_enrollments  from anon, authenticated;
revoke all on public.drip_sends        from anon, authenticated;
revoke all on public.drip_attributions from anon, authenticated;

-- ── Rollup RPC ──────────────────────────────────────────────────────────────
-- Single jsonb document; payload is independent of enrollment volume (bounded by
-- step/cohort/variant cardinality). `p_start`/`p_end` window the cohort by
-- enrolled_at. Reconciliation tolerance is documented + returned so the client
-- shows it without hardcoding.
create or replace function public.drip_analytics(
  p_campaign text default 'trial_conversion',
  p_start    timestamptz default (now() - interval '90 days'),
  p_end      timestamptz default now()
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with enroll as (
    select *
    from public.drip_enrollments e
    where e.campaign = p_campaign
      and e.enrolled_at >= p_start
      and e.enrolled_at <  p_end
  ),
  sends as (
    select s.*
    from public.drip_sends s
    join enroll e on e.id = s.enrollment_id
  ),
  attr as (
    select a.*, coalesce(e.trial_started_at, e.enrolled_at) as clock_start
    from public.drip_attributions a
    join enroll e on e.id = a.enrollment_id
  ),
  -- Per-step engagement.
  step_eng as (
    select
      s.step,
      min(s.phase)                                   as phase,
      count(*) filter (where s.sent_at is not null)    as sent,
      count(*) filter (where s.opened_at is not null)  as opened,
      count(*) filter (where s.clicked_at is not null) as clicked,
      count(*) filter (where s.unsubscribed)           as unsub
    from sends s
    group by s.step
  ),
  step_conv as (
    select a.step, count(*) as converted, coalesce(sum(a.mrr_cents), 0) as mrr_cents
    from attr a
    where a.step is not null
    group by a.step
  ),
  funnel as (
    select
      se.step,
      se.phase,
      se.sent,
      se.opened,
      se.clicked,
      se.unsub,
      coalesce(sc.converted, 0) as converted,
      coalesce(sc.mrr_cents, 0) as mrr_cents,
      -- drop-off to the next step: who received this step but not the next.
      greatest(se.sent - coalesce(lead(se.sent) over (order by se.step), 0), 0) as drop_to_next
    from step_eng se
    left join step_conv sc on sc.step = se.step
  ),
  -- Overall conversion + MRR + median days-to-convert.
  overall as (
    select
      (select count(*) from enroll)                                  as enrolled,
      (select count(*) from attr)                                    as converted,
      (select coalesce(sum(a.mrr_cents), 0) from attr a)             as mrr_cents,
      (select count(*) filter (where a.stripe_reconciled) from attr a) as reconciled,
      (select percentile_cont(0.5) within group (
                order by extract(epoch from (a.converted_at - a.clock_start)) / 86400.0)
              from attr a
              where a.converted_at is not null and a.clock_start is not null) as median_days
  ),
  -- in-trial vs win-back contribution.
  phase_split as (
    select a.phase,
           count(*) as converted,
           coalesce(sum(a.mrr_cents), 0) as mrr_cents
    from attr a
    group by a.phase
  ),
  -- incentive-on vs incentive-off lift.
  incentive_split as (
    select
      e.incentive_enabled,
      count(*) as enrolled,
      count(a.id) as converted
    from enroll e
    left join attr a on a.enrollment_id = e.id
    group by e.incentive_enabled
  ),
  -- signup-week cohorts.
  cohort as (
    select
      e.signup_week,
      count(*) as enrolled,
      count(a.id) as converted
    from enroll e
    left join attr a on a.enrollment_id = e.id
    where e.signup_week is not null
    group by e.signup_week
  ),
  -- A/B variant performance.
  variant_perf as (
    select
      coalesce(e.variant, 'default') as variant,
      count(*) as enrolled,
      count(a.id) as converted
    from enroll e
    left join attr a on a.enrollment_id = e.id
    group by coalesce(e.variant, 'default')
  )
  select jsonb_build_object(
    'campaign', p_campaign,
    'window', jsonb_build_object('start', p_start, 'end', p_end),
    'overall', (
      select jsonb_build_object(
        'enrolled', o.enrolled,
        'converted', o.converted,
        'conversionRate', case when o.enrolled > 0
                            then round(o.converted::numeric / o.enrolled, 4) else 0 end,
        'medianDaysToConvert', o.median_days,
        'attributedMrrCents', o.mrr_cents,
        'reconciledCount', o.reconciled,
        'reconciliationRate', case when o.converted > 0
                                then round(o.reconciled::numeric / o.converted, 4) else null end,
        'reconciliationTolerancePct', 2.0
      ) from overall o
    ),
    'funnel', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'step', f.step,
          'phase', f.phase,
          'sent', f.sent,
          'opened', f.opened,
          'clicked', f.clicked,
          'converted', f.converted,
          'unsub', f.unsub,
          'dropOff', f.drop_to_next,
          'mrrCents', f.mrr_cents
        ) order by f.step
      ), '[]'::jsonb) from funnel f
    ),
    'phaseSplit', (
      select jsonb_build_object(
        'inTrial', jsonb_build_object(
          'converted', coalesce((select converted from phase_split where phase = 'in_trial'), 0),
          'mrrCents',  coalesce((select mrr_cents from phase_split where phase = 'in_trial'), 0)
        ),
        'winBack', jsonb_build_object(
          'converted', coalesce((select converted from phase_split where phase = 'win_back'), 0),
          'mrrCents',  coalesce((select mrr_cents from phase_split where phase = 'win_back'), 0)
        )
      )
    ),
    'incentiveSplit', (
      select jsonb_build_object(
        'on', jsonb_build_object(
          'enrolled', coalesce((select enrolled from incentive_split where incentive_enabled), 0),
          'converted', coalesce((select converted from incentive_split where incentive_enabled), 0),
          'conversionRate', (
            select case when enrolled > 0 then round(converted::numeric / enrolled, 4) else 0 end
            from incentive_split where incentive_enabled
          )
        ),
        'off', jsonb_build_object(
          'enrolled', coalesce((select enrolled from incentive_split where not incentive_enabled), 0),
          'converted', coalesce((select converted from incentive_split where not incentive_enabled), 0),
          'conversionRate', (
            select case when enrolled > 0 then round(converted::numeric / enrolled, 4) else 0 end
            from incentive_split where not incentive_enabled
          )
        ),
        'liftPts', (
          select round(
            coalesce((select case when enrolled > 0 then converted::numeric / enrolled end
                      from incentive_split where incentive_enabled), 0)
            - coalesce((select case when enrolled > 0 then converted::numeric / enrolled end
                        from incentive_split where not incentive_enabled), 0), 4)
        )
      )
    ),
    'cohorts', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'week', c.signup_week,
          'enrolled', c.enrolled,
          'converted', c.converted,
          'conversionRate', case when c.enrolled > 0
                              then round(c.converted::numeric / c.enrolled, 4) else 0 end
        ) order by c.signup_week
      ), '[]'::jsonb) from cohort c
    ),
    'variants', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'variant', v.variant,
          'enrolled', v.enrolled,
          'converted', v.converted,
          'conversionRate', case when v.enrolled > 0
                              then round(v.converted::numeric / v.enrolled, 4) else 0 end
        ) order by case when v.enrolled > 0 then v.converted::numeric / v.enrolled else 0 end desc
      ), '[]'::jsonb) from variant_perf v
    ),
    -- Steps to investigate: high drop-off (>50% of sent didn't advance) or high
    -- unsub (>2% of sent). The frontend surfaces these as attention flags.
    'flags', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'step', f.step,
          'phase', f.phase,
          'reason', case
                      when f.sent > 0 and f.unsub::numeric / f.sent > 0.02 then 'high_unsub'
                      else 'high_dropoff'
                    end,
          'dropOffRate', case when f.sent > 0 then round(f.drop_to_next::numeric / f.sent, 4) else 0 end,
          'unsubRate', case when f.sent > 0 then round(f.unsub::numeric / f.sent, 4) else 0 end
        ) order by f.step
      ), '[]'::jsonb)
      from funnel f
      where f.sent > 0
        and (f.unsub::numeric / f.sent > 0.02 or f.drop_to_next::numeric / f.sent > 0.5)
    )
  );
$$;

comment on function public.drip_analytics(text, timestamptz, timestamptz) is
  'US-946: read-only trial-drip funnel/ROI rollup (funnel, cohorts, phase + incentive + A/B splits, attention flags). Reconciles against Stripe within reconciliationTolerancePct.';

grant execute on function public.drip_analytics(text, timestamptz, timestamptz) to service_role;

COMMIT;
