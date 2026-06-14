-- US-881: Background jobs & scheduler console — job-runs ledger.
--
-- RECONCILIATION DECISION (mirrors the project's reuse-over-duplication norm,
-- e.g. US-879 reusing gsc_performance, US-882 explicitly not duplicating US-487):
-- the existing `cron_runs` table (US-584 / 00164) IS the job-runs ledger. The
-- main.ts /api/jobs/* middleware already records ONE ROW PER cron/job invocation
-- with status + http_status + duration_ms + detail, so AC#1's "every cron/job
-- handler records a row" is already satisfied. Creating a parallel `job_runs`
-- table would force a second write path and drift. Instead we extend cron_runs
-- with the two columns US-881 names that it lacked:
--
--   * triggered_by   — who fired the run: 'schedule' (Coolify cron) or
--                      'admin:<uuid>' (a manual Run-now from the Operations
--                      console). Lets the console distinguish scheduled vs manual.
--   * rows_processed — optional count of items the run processed, when a handler
--                      reports one (the richer per-handler counts still live in
--                      the existing `detail` jsonb).
--
-- The US-881 status enum (running/succeeded/failed/skipped) maps onto the stored
-- vocabulary in the API layer (lib/ops-jobs.ts mapRunStatus): success→succeeded,
-- error→failed, skipped→skipped; "running" is derived live from a currently-held
-- job_locks row, so the append-only ledger and its CHECK constraint are unchanged.

ALTER TABLE public.cron_runs
  ADD COLUMN IF NOT EXISTS triggered_by   text,
  ADD COLUMN IF NOT EXISTS rows_processed integer;

COMMENT ON COLUMN public.cron_runs.triggered_by IS
  'US-881: who triggered this run — ''schedule'' (Coolify cron) or ''admin:<uuid>'' (manual Run-now from the Operations console).';
COMMENT ON COLUMN public.cron_runs.rows_processed IS
  'US-881: optional count of items the run processed, when the handler reports one (richer counts remain in detail jsonb).';
