-- US-1057: Amazon SES deliverability — bounce/complaint suppression list.
--
-- When SES reports a HARD bounce (bounceType=Permanent) or a complaint via its
-- SNS feedback topic, the recipient is written here. email.ts checks this list
-- before every send and skips suppressed recipients, protecting SES sender
-- reputation as volume grows (sending to known-bad addresses is the fastest way
-- to get throttled/blocked). Hard bounces auto-suppress; complaints suppress;
-- transient bounces are intentionally NOT suppressed.

create table if not exists public.email_suppressions (
  email       text primary key,                     -- normalized (trimmed, lowercased)
  reason      text not null
                check (reason in ('bounce', 'complaint', 'manual')),
  detail      text,                                  -- e.g. 'Permanent/General' or feedback type
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.email_suppressions is
  'US-1057: SES bounce/complaint suppression list checked by email.ts before send.';

-- Recency triage (most-recent suppressions first) for the ops dashboard.
create index if not exists email_suppressions_created_idx
  on public.email_suppressions (created_at desc);

-- updated_at maintenance (matches the project-wide trigger convention).
create or replace function public.set_email_suppressions_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_email_suppressions_updated_at on public.email_suppressions;
create trigger trg_email_suppressions_updated_at
  before update on public.email_suppressions
  for each row execute function public.set_email_suppressions_updated_at();

-- Service-role only (the edge service reads/writes it); not exposed to
-- anon/authenticated. RLS enabled with zero policies = deny-all to those roles.
alter table public.email_suppressions enable row level security;
revoke all on public.email_suppressions from anon, authenticated;
