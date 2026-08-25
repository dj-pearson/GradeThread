-- US-2848: the shadow comparison store.
--
-- One row every time valueAtGrade produced both answers for a cell: the live
-- conditionId-filtered range that shipped, and the measured-curve range that
-- did not. The delta between them is the evidence US-2849's flip turns on.
--
-- AGGREGATE MARKET DATA, same posture as comp_condition_reads (00663). No
-- seller, no submission, no listing, no owner column of any kind. A row is a
-- statement about a market cell at a grade, never about whose request produced
-- it, so there is nothing here for a tenant policy to scope to.
--
-- Deny-all RLS with zero policies. Written and read by the service-role edge.
-- Bounded by what it measures: nothing is written for a cell with no measured
-- curve, so the table stays empty until the US-2845 worker fits one.

create table if not exists public.condition_value_shadow_samples (
  id                     uuid primary key default gen_random_uuid(),
  -- normalizeItemKey: brand|categoryId|query, lowercased. The market cell.
  cell_key               text not null,
  grade                  numeric(3,1),
  live_median_cents      bigint,
  measured_median_cents  bigint,
  -- measured minus live. Null unless both sides produced a number.
  delta_cents            bigint,
  live_sample_size       int not null default 0,
  measured_sample_size   int not null default 0,
  live_sufficient        boolean not null default false,
  measured_sufficient    boolean not null default false,
  currency               text not null default 'USD',
  created_at             timestamptz not null default now(),
  constraint condition_value_shadow_samples_grade_range
    check (grade is null or (grade >= 1.0 and grade <= 10.0)),
  -- A delta may only exist where both sides did. Without this a row could carry
  -- a difference between a number and nothing and have it counted as evidence.
  constraint condition_value_shadow_samples_delta_needs_both
    check (
      delta_cents is null
      or (live_median_cents is not null and measured_median_cents is not null)
    )
);

comment on table public.condition_value_shadow_samples is
  'US-2848: live-vs-measured value range comparisons per market cell. No PII, no tenant identity.';

create index if not exists condition_value_shadow_samples_cell_idx
  on public.condition_value_shadow_samples (cell_key, created_at desc);
create index if not exists condition_value_shadow_samples_window_idx
  on public.condition_value_shadow_samples (created_at desc);

alter table public.condition_value_shadow_samples enable row level security;
revoke all on public.condition_value_shadow_samples from anon, authenticated;

insert into public.applied_migrations (version) values ('00665') on conflict do nothing;
