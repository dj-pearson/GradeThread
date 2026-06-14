-- US-890: rate-limit administration & temporary throttles.
--
-- The distributed rate limiter (US-265, rate_limit_counters + increment_rate_limit)
-- applies one fixed budget per (scope, subject). This table lets an operator set a
-- TEMPORARY per-user override on top of that budget WITHOUT a deploy:
--   • mode='multiplier' — scale every limit for this user (e.g. 0.25 to throttle an
--     abusive caller, 5 to lift the cap for a trusted high-volume seller);
--   • mode='cap'        — pin every limit to an absolute per-minute number;
--   • mode='block'      — hard 429 every request until the override expires.
-- The limiter honors the active override at request time (lib/rate-limit-overrides.ts
-- read-through cache); an EXPIRED override is ignored at read time (query filters
-- expires_at > now() AND the sync getter re-checks expiry), so there is no cleanup
-- job to keep an override alive past its window.
--
-- Service-role only: this is an OPERATOR enforcement record — a user must NOT be
-- able to read (or evade) a throttle/block set on their account. The SPA reaches it
-- exclusively through /api/admin/safety/rate-limits/* (admin JWT + AAL2) on the
-- service-role client, so there are no client RLS policies (RLS on + deny-all +
-- revoke writes). NOTE the column is `subject_user_id`, not `user_id`: this is
-- deliberate so the tenant-isolation RLS guard does not misclassify this admin-only
-- table as user-owned tenant data (it auto-discovers `user_id`).

create table if not exists public.rate_limit_overrides (
  -- One active override per user — setting a new one upserts on this PK.
  subject_user_id  uuid primary key references public.users(id) on delete cascade,
  mode             text not null check (mode in ('multiplier', 'cap', 'block')),
  -- For mode='multiplier': the factor applied to each base limit (>= 0).
  multiplier       numeric,
  -- For mode='cap': the absolute per-window request ceiling (>= 0).
  cap              integer,
  -- Required: why this override exists (shows in the console + audit trail).
  reason           text not null,
  -- Required: when the override stops applying. Past this instant the limiter
  -- ignores the row even if it is still present.
  expires_at       timestamptz not null,
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Exactly one knob is set per mode; the others are null.
  constraint rate_limit_overrides_shape check (
    (mode = 'multiplier' and multiplier is not null and multiplier >= 0 and cap is null) or
    (mode = 'cap'        and cap is not null and cap >= 0 and multiplier is null) or
    (mode = 'block'      and multiplier is null and cap is null)
  )
);

comment on table public.rate_limit_overrides is
  'US-890: temporary per-user rate-limit overrides (throttle/boost/block) honored by the edge limiter. Service-role only (deny-all RLS). subject_user_id (not user_id) is intentional so the tenant-isolation guard does not treat this admin-only table as user-owned data. Expired rows are ignored at read time — no cleanup job.';

-- The limiter loads ALL currently-active overrides in one query each cache window.
create index if not exists idx_rate_limit_overrides_expires_at
  on public.rate_limit_overrides (expires_at);

create or replace function public.set_rate_limit_overrides_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_rate_limit_overrides_updated_at on public.rate_limit_overrides;
create trigger trg_rate_limit_overrides_updated_at
  before update on public.rate_limit_overrides
  for each row execute function public.set_rate_limit_overrides_updated_at();

-- Service-role only (no client policies) — see header. RLS on + revoke writes:
-- anon/authenticated get nothing (deny-all); the edge service-role client is the
-- only read/write path.
alter table public.rate_limit_overrides enable row level security;
revoke insert, update, delete on public.rate_limit_overrides from anon, authenticated;

-- ── Caps & defaults for the override console come from the system_settings
-- registry (US-884) so they can be retuned without a deploy. The POST handler
-- validates a requested override against these bounds. `on conflict do nothing`
-- so a manual retune is never clobbered on re-run.
insert into public.system_settings (key, value, value_type, default_value, category, description)
values
  (
    'rate_limit_override_max_multiplier',
    to_jsonb(20::numeric), 'number', to_jsonb(20::numeric), 'rate_limits',
    'Largest multiplier an operator may apply when boosting a user''s rate limits.'
  ),
  (
    'rate_limit_override_max_duration_minutes',
    to_jsonb(10080), 'number', to_jsonb(10080), 'rate_limits',
    'Longest a temporary rate-limit override may last, in minutes (default 7 days).'
  )
on conflict (key) do nothing;
