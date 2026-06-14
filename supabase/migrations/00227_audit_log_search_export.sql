-- US-905: Audit log search, export & anomaly alerting.
--
-- Builds on the existing append-only admin_audit_log (00003 + 00065). Adds:
--   1. admin_audit_log_search() — server-side full-text search (action /
--      target / details) + the same actor/action/target/date filters the
--      console already exposes, with server-side pagination and a window
--      total_count so the page never downloads the whole log to filter or
--      free-text-search the jsonb `details`.
--   2. admin_audit_anomalies — an OPERATOR surface (deny-all RLS, service-role
--      only) the scheduled anomaly scan writes flagged patterns to (burst of
--      role changes, mass refunds, off-hours destructive actions). Keyed by
--      detector + a stable dedupe window so a re-run refreshes rather than
--      duplicates and the ops alert fires once per window.
--   3. Settings-registry thresholds (system_settings) so the patterns are
--      retunable WITHOUT a deploy.
--
-- admin_audit_log itself stays append-only: 00003 defines ONLY SELECT + INSERT
-- RLS policies, so UPDATE/DELETE remain denied to every non-service-role caller.
-- This migration adds NO update/delete policy to it. (Re-asserted by the
-- audit-append-only_test.ts RLS guard.)

-- ────────────────────────────────────────────────────────────────────
-- 1. Server-side search + filter RPC
-- ────────────────────────────────────────────────────────────────────
-- Mirrors admin_audit_log_filter_options (00147): SECURITY DEFINER with an
-- is_admin() gate, granted to authenticated + service_role. NULL params are
-- "no filter". p_search ILIKEs across action, target_type, target_id and the
-- whole jsonb `details` cast to text. total_count is the COUNT(*) OVER() of the
-- filtered set, so the caller paginates without a second query.
create or replace function public.admin_audit_log_search(
  p_search       text default null,
  p_admin        uuid default null,
  p_action       text default null,
  p_target_type  text default null,
  p_from         timestamptz default null,
  p_to           timestamptz default null,
  p_limit        int default 25,
  p_offset       int default 0
)
returns table (
  id            uuid,
  admin_user_id uuid,
  actor_role    text,
  action        text,
  target_type   text,
  target_id     uuid,
  details       jsonb,
  ip            text,
  user_agent    text,
  created_at    timestamptz,
  total_count   bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- Cap high enough to back a full forensic EXPORT (service-role edge caller),
  -- while the paginated console reads pass a small p_limit (default 25).
  v_limit  int := least(greatest(coalesce(p_limit, 25), 1), 50000);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_like   text;
begin
  -- Authenticated admin (console) OR the service-role edge client (export).
  -- Mirrors the 00207 system-health guard.
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'admin_audit_log_search: admin role required'
      using errcode = '42501';
  end if;

  v_like := case when v_search is null then null else '%' || v_search || '%' end;

  return query
  with filtered as (
    select
      a.id, a.admin_user_id, a.actor_role, a.action, a.target_type,
      a.target_id, a.details, a.ip, a.user_agent, a.created_at,
      count(*) over () as total_count
    from public.admin_audit_log a
    where (p_admin is null or a.admin_user_id = p_admin)
      and (p_action is null or a.action = p_action)
      and (p_target_type is null or a.target_type = p_target_type)
      and (p_from is null or a.created_at >= p_from)
      and (p_to is null or a.created_at <= p_to)
      and (
        v_like is null
        or a.action ilike v_like
        or a.target_type ilike v_like
        or coalesce(a.target_id::text, '') ilike v_like
        or coalesce(a.details::text, '') ilike v_like
      )
    order by a.created_at desc
    limit v_limit offset v_offset
  )
  select * from filtered;
end;
$$;

comment on function public.admin_audit_log_search(
  text, uuid, text, text, timestamptz, timestamptz, int, int
) is
  'US-905: server-side audit-log search (action/target/details ILIKE) + '
  'actor/action/target/date filters, paginated with a window total_count. '
  'SECURITY DEFINER + is_admin() guard.';

grant execute on function public.admin_audit_log_search(
  text, uuid, text, text, timestamptz, timestamptz, int, int
) to authenticated;
grant execute on function public.admin_audit_log_search(
  text, uuid, text, text, timestamptz, timestamptz, int, int
) to service_role;

-- A GIN trigram index on the searchable text would speed the ILIKE, but pg_trgm
-- is not guaranteed enabled on the self-hosted instance and the search is an
-- admin-only, paginated, low-QPS surface — the existing created_at index plus
-- the LIMIT keep it bounded. Left as a future optimization if the log grows.

-- ────────────────────────────────────────────────────────────────────
-- 2. Anomaly findings — operator surface (deny-all RLS, service-role only)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.admin_audit_anomalies (
  id            uuid primary key default gen_random_uuid(),
  -- Which configured pattern fired: role_change_burst | mass_refund |
  -- off_hours_destructive.
  detector      text not null,
  severity      text not null default 'warning',
  -- Stable per-window key so a re-run UPDATES the open finding (refreshing the
  -- count/evidence) instead of inserting a duplicate, and the ops alert fires
  -- once per window. e.g. 'role_change_burst:<actor>:<hour-bucket>'.
  dedupe_key    text not null unique,
  -- The acting admin implicated (nullable — some detectors are platform-wide).
  -- NOT a tenant key: this is an operator surface, never user-owned data.
  actor_user_id uuid references public.users(id) on delete set null,
  -- How many qualifying events drove the finding (e.g. role changes in window).
  event_count   int not null default 0,
  -- Free-form structured evidence (window bounds, sample audit ids, threshold).
  evidence      jsonb not null default '{}'::jsonb,
  -- Whether an ops alert was delivered to at least one channel.
  alerted       boolean not null default false,
  -- Triage lifecycle: open -> acknowledged. Resolved findings are kept for
  -- forensics; a later re-breach opens a NEW dedupe window.
  status        text not null default 'open',
  acknowledged_by uuid references public.users(id) on delete set null,
  acknowledged_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists idx_admin_audit_anomalies_status
  on public.admin_audit_anomalies(status, last_seen_at desc);
create index if not exists idx_admin_audit_anomalies_detector
  on public.admin_audit_anomalies(detector);

-- RLS enabled with ZERO policies by design: anon/authenticated get nothing and
-- only the service-role edge client (scheduled scan + admin console endpoints)
-- reads/writes it. Most restrictive configuration, not a gap. (Classified in
-- rls-guard_test.ts SERVICE_ROLE_ONLY.)
alter table public.admin_audit_anomalies enable row level security;
revoke all on public.admin_audit_anomalies from anon, authenticated;

comment on table public.admin_audit_anomalies is
  'US-905: anomaly findings raised by the scheduled audit-log scan '
  '(role-change bursts, mass refunds, off-hours destructive actions). '
  'Operator surface — service-role only, deny-all RLS.';

-- ────────────────────────────────────────────────────────────────────
-- 3. Configurable thresholds in the settings registry
-- ────────────────────────────────────────────────────────────────────
insert into public.system_settings (key, value, value_type, default_value, category, description)
values
  (
    'audit_anomaly_enabled',
    to_jsonb(true), 'bool', to_jsonb(true), 'security',
    'US-905: master switch for the scheduled audit-log anomaly scan.'
  ),
  (
    'audit_anomaly_role_changes_per_hour',
    to_jsonb(5), 'number', to_jsonb(5), 'security',
    'US-905: flag when a single admin makes more than this many role-change '
    'audit entries within one hour (privilege-escalation burst).'
  ),
  (
    'audit_anomaly_refunds_per_hour',
    to_jsonb(10), 'number', to_jsonb(10), 'security',
    'US-905: flag when more than this many refund/credit audit entries are '
    'written platform-wide within one hour (mass-refund signal).'
  ),
  (
    'audit_anomaly_business_hours_start',
    to_jsonb(7), 'number', to_jsonb(7), 'security',
    'US-905: start of business hours (UTC, 0-23). Destructive admin actions '
    'before this hour or at/after the end hour are flagged as off-hours.'
  ),
  (
    'audit_anomaly_business_hours_end',
    to_jsonb(20), 'number', to_jsonb(20), 'security',
    'US-905: end of business hours (UTC, 0-23, exclusive). See '
    'audit_anomaly_business_hours_start.'
  )
on conflict (key) do nothing;
