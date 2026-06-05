-- US-498: durable retry / dead-letter for transactional email.
--
-- email.ts sends once and returns false on a transient SMTP failure; callers
-- ignore the boolean, so a "your grade is ready" or "your card failed" email is
-- silently lost on a blip. This table is the outbox: a failed CRITICAL send is
-- persisted and retried with exponential backoff, then dead-lettered after N
-- attempts so it can be surfaced/replayed instead of vanishing.

create table if not exists public.email_deliveries (
  id              uuid primary key default gen_random_uuid(),
  recipient       text not null,
  subject         text not null,
  html            text not null,
  category        text not null,          -- e.g. 'payment_failed', 'grade_ready'
  status          text not null default 'pending'
                    check (status in ('pending', 'sent', 'dead_letter')),
  attempts        int  not null default 0,
  max_attempts    int  not null default 6,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_at         timestamptz
);

comment on table public.email_deliveries is
  'US-498: outbox for critical transactional email with backoff retry + dead-letter.';

-- The retry cron scans by (status, next_attempt_at); dead-letter triage scans by
-- status. One partial index covers the hot retry path.
create index if not exists email_deliveries_due_idx
  on public.email_deliveries (next_attempt_at)
  where status = 'pending';

create index if not exists email_deliveries_status_idx
  on public.email_deliveries (status, created_at desc);

-- updated_at maintenance (matches the project-wide trigger convention).
create or replace function public.set_email_deliveries_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_email_deliveries_updated_at on public.email_deliveries;
create trigger trg_email_deliveries_updated_at
  before update on public.email_deliveries
  for each row execute function public.set_email_deliveries_updated_at();

-- Service-role only (the edge service); not exposed to anon/authenticated.
alter table public.email_deliveries enable row level security;
revoke all on public.email_deliveries from anon, authenticated;
