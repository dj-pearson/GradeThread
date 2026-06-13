-- US-584: cron-run ledger for the admin job/queue monitoring dashboard.
--
-- The scheduled jobs (/api/jobs/*) run unattended on Coolify cron. Until now
-- the only evidence a cron fired was a log line or a side-effect table
-- (flipdesk_sync_runs, grading_monitor_runs, …). There was no single place an
-- operator could see "did the email-retry sweep run, when, and did it succeed?"
-- across ALL crons. This table is that ledger: one row per /api/jobs/* hit
-- (recorded by a thin middleware in main.ts), so the admin Jobs page can show
-- each cron's last-run time, outcome, and duration, and compute the next run
-- from the known schedule.
--
-- Rows are tiny and bounded — a daily prune in the data-retention sweep keeps
-- only the recent window (RETAIN below mirrors that), so this never grows
-- unbounded even at the */5 cadence of the busiest jobs.

CREATE TABLE IF NOT EXISTS public.cron_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The job name, derived from the last path segment of /api/jobs/<name>
  -- (e.g. 'email-retry', 'reprice-scan'). Matched against the static registry
  -- in the edge service to resolve the human label + schedule.
  job_name    text NOT NULL,
  -- success → handler returned < 400; error → >= 400 (incl. the handler's own
  -- job-secret rejection); skipped is reserved for lock-contended ticks.
  status      text NOT NULL DEFAULT 'success'
                CHECK (status IN ('success', 'error', 'skipped')),
  http_status integer,
  duration_ms integer,
  -- Small structured extras (e.g. the resulting counts a handler returns).
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cron_runs IS
  'US-584: one row per /api/jobs/* invocation. Powers the admin Jobs dashboard '
  'cron health view (last-run / outcome / duration). Pruned in data-retention.';

-- The dashboard reads "latest run per job", so (job_name, created_at DESC) is
-- the hot path; a plain created_at index covers the daily prune scan.
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_created
  ON public.cron_runs (job_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_created
  ON public.cron_runs (created_at);

-- Service-role only: written by the edge middleware, read by admin endpoints
-- (which also use the service-role client). No anon/authenticated access.
ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cron_runs FROM anon, authenticated;
