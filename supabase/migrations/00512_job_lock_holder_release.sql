-- US-2311: release_job_lock must not destroy a lock it no longer holds.
--
-- 00094 defined release_job_lock(p_job) as an unconditional DELETE. The lease
-- makes a crashed holder recoverable, but it also means a SLOW holder can be
-- legitimately displaced — and then delete the displacing run's live lock:
--
--   t=0:00  tick 1 acquires (300s lease)
--   t=5:00  lease expires; tick 2 legitimately steals the lock
--   t=5:30  tick 1 finishes and DELETES tick 2's lock
--   t=10:00 tick 3 acquires freely — now running concurrently with tick 2
--
-- Mutual exclusion does not degrade there, it disappears, and the more loaded
-- the box the more concurrent runs there are.
--
-- The `holder` column has existed since 00094 and try_acquire_job_lock already
-- stores it; nothing ever passed one. This adds the matching check on release.
--
-- Backward compatible in BOTH directions, which is what makes it safe to apply
-- before the edge rolls:
--   • p_holder null (what the current edge build sends) → unconditional delete,
--     i.e. exactly today's behaviour.
--   • p_holder set (the new build) → deletes only its own lock.
-- The one-arg function is DROPPED rather than left alongside: two overloads
-- where one has a defaulted second argument makes a named-argument call from
-- PostgREST ambiguous ("function is not unique").

-- Transactional on purpose. Without it, autocommit leaves a window between the
-- DROP and the CREATE in which release_job_lock does not exist at all — a cron
-- releasing inside it gets "function does not exist", swallowed into a
-- job.release_failed warn, and its lock then survives to lease expiry. The same
-- wrapper also makes a full-directory replay atomic, so the moment when 00094's
-- one-arg function and this two-arg one coexist (and a one-arg call would hit
-- "function is not unique") is never observable by a live edge.
begin;

drop function if exists public.release_job_lock(text);

create or replace function public.release_job_lock(
  p_job text,
  p_holder text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.job_locks
   where job_name = p_job
     and (p_holder is null or holder = p_holder);
$$;

comment on function public.release_job_lock(text, text) is
  'US-503/US-2311: release a job lock acquired via try_acquire_job_lock. When p_holder is supplied the delete only fires if that holder still owns the lock, so a displaced slow run cannot destroy its successor''s lease.';

-- The edge service uses the service-role key; keep the function uncallable by
-- anon/authenticated PostgREST clients (the DROP above took the old grants with
-- it, so this must be restated).
revoke all on function public.release_job_lock(text, text) from public, anon, authenticated;

-- ...and GRANT service_role explicitly rather than relying on the applying
-- role's default privileges to hand it back.
--
-- This is the one way a DROP+CREATE migration differs from the CREATE OR
-- REPLACE ones everywhere else in this directory: REPLACE preserves the ACL,
-- but a dropped function is a brand-new object that inherits nothing. Its
-- privileges then come only from `alter default privileges` owned by the
-- APPLYING role. Applied as `postgres` (the Studio SQL editor, per
-- vault/10-ops/migrations-process.md) that restores service_role EXECUTE and
-- all is well; applied as any other superuser it does NOT, and every
-- release_job_lock call from the edge returns 42501 permission-denied — locks
-- would then only ever expire on lease, silently, with a job.release_failed
-- warn per tick. Naming the grant removes the dependency on who ran the file.
grant execute on function public.release_job_lock(text, text) to service_role;

insert into public.applied_migrations (version) values ('00512') on conflict do nothing;

commit;
