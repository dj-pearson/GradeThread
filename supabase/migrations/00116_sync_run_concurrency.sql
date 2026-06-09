-- eBay sync: one in-flight run per tenant + reapable stale runs (US-456).
--
-- /listings/pull had no in-flight lock, so two overlapping pulls could race
-- their writes, and a pull that threw AFTER the offer fetch (or whose container
-- died) left its flipdesk_sync_runs row stuck in 'running' forever — the UI's
-- "syncing…" state never cleared. This adds a race-free claim (a partial unique
-- index: at most ONE 'running' row per user+marketplace) and lets a reaper flip
-- stale 'running' rows to 'failed'.

-- Clear any pre-existing stuck 'running' rows BEFORE creating the unique index,
-- otherwise an account that already has >1 running row would fail index
-- creation. These are crashed/never-finalized runs — mark them failed.
UPDATE public.flipdesk_sync_runs
  SET status = 'failed',
      finished_at = COALESCE(finished_at, now())
  WHERE status = 'running';

-- At most one in-flight sync per (user, marketplace). claimSyncRun() inserts a
-- 'running' row and treats a unique violation as "a sync is already running".
CREATE UNIQUE INDEX IF NOT EXISTS idx_flipdesk_sync_runs_one_running
  ON public.flipdesk_sync_runs (user_id, marketplace)
  WHERE status = 'running';

-- The reaper scans by (status, started_at); back it with an index so the sweep
-- stays cheap as run history grows.
CREATE INDEX IF NOT EXISTS idx_flipdesk_sync_runs_running_started
  ON public.flipdesk_sync_runs (started_at)
  WHERE status = 'running';
