-- US-1918: lock down public.job_locks (service-role-only cron infrastructure).
--
-- 00094 revoked the two RPCs (try_acquire_job_lock / release_job_lock) from
-- anon/authenticated but left the job_locks TABLE with default PostgREST grants
-- and no RLS. It was the only table of 239 lacking BOTH RLS and REVOKE. As-is,
-- any authenticated client could `DELETE FROM job_locks` (clearing a lease so
-- two mutating cron runs execute concurrently — the exact double-publish /
-- double-reprice / double-downgrade race the table exists to prevent) or INSERT
-- a long-lease bogus row to wedge every mutating cron.
--
-- Match the service-only-table convention (abuse_signals, cron_runs,
-- newsletter_*, system_settings): REVOKE ALL from anon/authenticated AND enable
-- deny-all RLS (zero policies). The edge cron paths use the service-role client,
-- which BYPASSES RLS, so acquire/release stay unchanged.

revoke all on public.job_locks from anon, authenticated;

alter table public.job_locks enable row level security;
-- No CREATE POLICY: zero policies => deny-all for anon/authenticated.

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00436') ON CONFLICT DO NOTHING;
