-- US-1931: make the AutoLister per-item AI-action reservation idempotent per job.
--
-- reserveAiAction is charged before generateListing and refunded only in the
-- catch (flipdesk-autolister.ts runJob). A container death between reserve and
-- refund LEAKS the reservation; on reclaim the job is re-claimed (attempts+1)
-- and reserved AGAIN, so a crash loop could burn up to MAX_JOB_ATTEMPTS (5)
-- reservations for a single item. This column records whether a job currently
-- holds a reservation so the worker can REUSE it on reclaim instead of charging
-- the owner's monthly cap a second time — a single item holds at most one
-- reservation, and the batch pre-check's `used` snapshot stays truthful.

alter table public.listing_generation_jobs
  add column if not exists ai_reserved boolean not null default false;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00445') ON CONFLICT DO NOTHING;
