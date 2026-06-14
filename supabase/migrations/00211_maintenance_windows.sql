-- US-887: maintenance mode + scheduled maintenance windows.
--
-- Operators can put the whole platform or a single subsystem (grading / flipdesk
-- / checkout) into maintenance — immediately or on a schedule — with a
-- user-facing notice and an optional enforcement level:
--   banner    — informational only (the SPA shows a dismissible notice).
--   read_only — the edge rejects writes (POST/PUT/PATCH/DELETE) for non-admins.
--   blocked   — the edge 503s all in-scope requests for non-admins.
-- Admins ALWAYS bypass enforcement (so they can keep operating and end the
-- window). Enforcement lives in the edge maintenance guard + lib/maintenance.ts;
-- this table is the source of truth it reads (short cache).
--
-- Service-role only: the SPA reads effective windows through the PUBLIC edge
-- endpoint /api/maintenance/active and admins manage them through
-- /api/admin/ops/maintenance — never via PostgREST — so there are no client RLS
-- policies (RLS on + deny-all + revoke writes).

create type public.maintenance_scope as enum ('platform', 'grading', 'flipdesk', 'checkout');
create type public.maintenance_mode as enum ('banner', 'read_only', 'blocked');

create table if not exists public.maintenance_windows (
  id          uuid primary key default gen_random_uuid(),
  scope       public.maintenance_scope not null default 'platform',
  mode        public.maintenance_mode  not null default 'banner',
  message     text not null,
  -- When the window takes effect / expires. NULL starts_at = effective as soon
  -- as is_active is true; NULL ends_at = open-ended until an operator ends it.
  starts_at   timestamptz,
  ends_at     timestamptz,
  -- Master on/off. A SCHEDULED window is created is_active=true with a future
  -- starts_at; an "end now" flips this false. A window is effective-now when
  -- is_active AND now() is in [starts_at, ends_at).
  is_active   boolean not null default true,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.maintenance_windows is
  'US-887: platform/subsystem maintenance windows. mode banner|read_only|blocked; scope platform|grading|flipdesk|checkout. Read by the edge maintenance guard (short cache) + the public /api/maintenance/active endpoint; managed via /api/admin/ops/maintenance. Admins always bypass enforcement.';

-- Hot lookup: the guard + the public endpoint pull the active set every request
-- (cached), filtered by is_active.
create index if not exists idx_maintenance_windows_active
  on public.maintenance_windows (is_active, starts_at, ends_at);

create or replace function public.set_maintenance_windows_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_maintenance_windows_updated_at on public.maintenance_windows;
create trigger trg_maintenance_windows_updated_at
  before update on public.maintenance_windows
  for each row execute function public.set_maintenance_windows_updated_at();

-- Service-role only (no client policies) — see header. RLS on + revoke writes:
-- anon/authenticated get nothing (deny-all); the edge service-role client is the
-- only read/write path.
alter table public.maintenance_windows enable row level security;
revoke insert, update, delete on public.maintenance_windows from anon, authenticated;
