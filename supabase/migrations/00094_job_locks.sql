-- US-503: overlap locks for scheduled jobs (crons).
--
-- A slow cron run must not race the next invocation and double-apply work
-- (double-publish, double-reprice, double-downgrade). Each mutating cron
-- acquires a lease-based lock keyed by job name before doing work and releases
-- it after. A crashed holder's lock auto-expires after its lease, so a dead run
-- can't wedge a job forever.
--
-- We use a lease/claim row (not pg_advisory_lock) because the edge service talks
-- to Postgres over PostgREST with no persistent session — a session-scoped
-- advisory lock would be released the instant the RPC returns.

create table if not exists public.job_locks (
  job_name     text primary key,
  locked_at    timestamptz not null default now(),
  locked_until timestamptz not null,
  holder       text
);

comment on table public.job_locks is
  'US-503: lease-based mutual exclusion for scheduled cron jobs. One row per job.';

-- Atomically acquire the lock for p_job if it is free OR its lease has expired.
-- Returns TRUE iff the caller now holds the lock. The ON CONFLICT update only
-- fires when the existing lease is in the past, so a live holder is never
-- displaced; row_count then reflects whether we inserted/stole the lock.
create or replace function public.try_acquire_job_lock(
  p_job text,
  p_lease_seconds int,
  p_holder text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  insert into public.job_locks (job_name, locked_at, locked_until, holder)
  values (
    p_job,
    now(),
    now() + make_interval(secs => p_lease_seconds),
    p_holder
  )
  on conflict (job_name) do update
    set locked_at    = now(),
        locked_until = now() + make_interval(secs => p_lease_seconds),
        holder       = p_holder
    where public.job_locks.locked_until < now();

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

comment on function public.try_acquire_job_lock(text, int, text) is
  'US-503: returns true and claims the lease if the named job is free or expired; false if a live run holds it.';

-- Release a held lock so the next scheduled run can re-acquire immediately
-- (rather than waiting out the lease). Safe to call even if not held.
create or replace function public.release_job_lock(p_job text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.job_locks where job_name = p_job;
$$;

comment on function public.release_job_lock(text) is
  'US-503: release a job lock acquired via try_acquire_job_lock.';

-- The edge service uses the service-role key; lock the functions down so they
-- are not callable by anon/authenticated PostgREST clients.
revoke all on function public.try_acquire_job_lock(text, int, text) from public, anon, authenticated;
revoke all on function public.release_job_lock(text) from public, anon, authenticated;
