-- US-888: fraud & abuse signals console.
--
-- The existing /api/admin/fraud "Abuse & Fraud" dashboard computes a LIVE
-- aggregate on every request (repeat offenders, velocity, shared payment) — it
-- has no memory and nothing to triage. This table is the durable, stateful
-- counterpart: a scheduled job (jobs-abuse-scan.ts) writes one row per detected
-- signal — most importantly cross-account perceptual-hash (phash) photo reuse,
-- which the live dashboard does NOT compute — and operators move each signal
-- through open -> reviewing -> actioned/dismissed, acting via the existing
-- audited moderation/suspend endpoints. It complements, never duplicates, the
-- live dashboard and per-submission moderation.
--
-- Service-role only: this is an OPERATOR safety surface — a user must NOT be able
-- to read signals raised about their own (or anyone's) account. The SPA reads it
-- exclusively through /api/admin/safety/* (admin JWT + AAL2) on the service-role
-- client, so there are no client RLS policies (RLS on + deny-all + revoke
-- writes). NOTE the column is `subject_user_id`, not `user_id`: this is
-- deliberate so the tenant-isolation RLS guard does not misclassify an
-- admin-only table as user-owned tenant data (it auto-discovers `user_id`).

create type public.abuse_signal_type as enum (
  'phash_collision',     -- same photo reused across DIFFERENT accounts
  'submission_velocity', -- abnormal burst of submissions from one account
  'shared_payment',      -- many accounts on one Stripe customer
  'disposable_email'     -- signup with a known throwaway email domain
);

create type public.abuse_signal_severity as enum ('low', 'medium', 'high', 'critical');

create type public.abuse_signal_status as enum ('open', 'reviewing', 'actioned', 'dismissed');

create table if not exists public.abuse_signals (
  id               uuid primary key default gen_random_uuid(),
  signal_type      public.abuse_signal_type     not null,
  severity         public.abuse_signal_severity not null default 'medium',
  status           public.abuse_signal_status   not null default 'open',
  -- The account the signal is RAISED ABOUT. on delete cascade so deleting a user
  -- clears their signals (no orphaned forensic noise).
  subject_user_id  uuid not null references public.users(id) on delete cascade,
  -- Stable identity for an in-progress concern so the scan is idempotent: a
  -- re-run UPDATES the evidence/last_seen of an existing open/reviewing signal
  -- rather than piling up duplicates, and never reopens one already
  -- actioned/dismissed. e.g. 'phash_collision:<userA>|<userB>' (sorted pair),
  -- 'submission_velocity:<user>:<utc-date>'.
  dedupe_key       text not null unique,
  -- Collision FACT + ids only — never image bytes or signed URLs (US-888 AC4).
  evidence         jsonb not null default '{}'::jsonb,
  -- Triage trail. resolution_reason is required by the API on dismiss.
  resolved_by      uuid references public.users(id) on delete set null,
  resolution_reason text,
  resolved_at      timestamptz,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.abuse_signals is
  'US-888: durable, triageable fraud/abuse signals (phash photo reuse, submission velocity, shared payment, disposable email). Populated by the abuse-scan cron; managed via /api/admin/safety/*. Service-role only (deny-all RLS). subject_user_id (not user_id) is intentional so the tenant-isolation guard does not treat this admin-only table as user-owned data. evidence holds only ids + hashes + counts, never image bytes.';

-- The console lists by status, filtered by type/severity, newest first.
create index if not exists idx_abuse_signals_triage
  on public.abuse_signals (status, signal_type, severity, last_seen_at desc);
create index if not exists idx_abuse_signals_subject
  on public.abuse_signals (subject_user_id);

create or replace function public.set_abuse_signals_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_abuse_signals_updated_at on public.abuse_signals;
create trigger trg_abuse_signals_updated_at
  before update on public.abuse_signals
  for each row execute function public.set_abuse_signals_updated_at();

-- Service-role only (no client policies) — see header. RLS on + revoke writes:
-- anon/authenticated get nothing (deny-all); the edge service-role client is the
-- only read/write path.
alter table public.abuse_signals enable row level security;
revoke insert, update, delete on public.abuse_signals from anon, authenticated;
