-- US-585: waitlist / beta / early-access gating.
--
-- The 2026-04-01 launch is staged: we capture interested sellers into a
-- waitlist, an operator reviews/approves/invites them in cohorts, and a
-- SERVER-ENFORCED gate (not just UI) blocks gated flows for any authenticated
-- account that hasn't been approved while gating is active.
--
-- Pieces:
--   1. waitlist_entries  — capture + review/approve/invite lifecycle + cohorts.
--   2. waitlist_gating    feature_flags row — the master on/off switch. When OFF
--      (the default), the gate is inactive and everyone has access (so turning
--      gating on is a deliberate, reversible operator action, and a fresh deploy
--      never accidentally locks everyone out).

-- ── 1. waitlist_entries ──────────────────────────────────────────────────────
create table if not exists public.waitlist_entries (
  id           uuid primary key default gen_random_uuid(),
  -- Always stored lowercased (every write path normalizes), so a plain column
  -- UNIQUE gives case-insensitive dedup AND is a valid ON CONFLICT (email)
  -- target for the capture/admin upserts (a functional lower(email) index is
  -- not usable as a PostgREST on_conflict target).
  email        text not null unique,
  full_name    text,
  -- Free-form cohort label for staged invites, e.g. 'beta', 'wave-1'.
  cohort       text,
  -- pending → approved → invited; rejected is terminal.
  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'invited', 'rejected')),
  -- Where the signup came from (landing form, manual add, referral, etc.).
  source       text,
  referral_code text,
  -- Linked once the person actually signs up (matched by email). NULL until then.
  user_id      uuid references public.users(id) on delete set null,
  notes        text,
  metadata     jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  approved_at  timestamptz,
  approved_by  uuid references public.users(id) on delete set null,
  invited_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.waitlist_entries is
  'US-585: staged-launch waitlist. One row per interested email; status tracks the review/approve/invite lifecycle; cohort buckets invites. The edge access-gate treats status approved|invited as "has access".';

create index if not exists waitlist_entries_status_idx
  on public.waitlist_entries (status);
create index if not exists waitlist_entries_cohort_idx
  on public.waitlist_entries (cohort);
create index if not exists waitlist_entries_user_id_idx
  on public.waitlist_entries (user_id);

create or replace function public.set_waitlist_entries_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_waitlist_entries_updated_at on public.waitlist_entries;
create trigger trg_waitlist_entries_updated_at
  before update on public.waitlist_entries
  for each row execute function public.set_waitlist_entries_updated_at();

-- Service-role only. Capture goes through the edge (service-role), admins review
-- through audited edge routes, and the gate reads via service-role. The SPA
-- never touches this table directly.
alter table public.waitlist_entries enable row level security;
revoke all on public.waitlist_entries from anon, authenticated;

-- ── 2. master gating switch (reuses feature_flags from 00096) ────────────────
-- enabled=false → gate INACTIVE (everyone allowed). Flip to true to stage the
-- launch. Seeded OFF so this migration can never lock out existing accounts.
insert into public.feature_flags (key, enabled, description) values
  ('waitlist_gating', false,
   'US-585: when true, gated flows require an approved/invited waitlist entry (or an admin/reviewer role). Off = open access.')
on conflict (key) do nothing;
