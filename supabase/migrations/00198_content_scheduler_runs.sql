-- US-869: Scheduler + webhook observability.
--
-- A durable per-tick heartbeat for the content scheduler. content-scheduler.ts
-- writes ONE row per /tick (success, skip, or error) so the content-watchdog
-- cron can prove the autonomous engine is still alive: "no non-error tick in
-- the last 3 hours" is a stall. Without this, a silently-wedged scheduler
-- (cron disabled, container crash-looping, settings row missing) would publish
-- nothing and nobody would know.
--
-- Writes are service-role only (the scheduler runs unattended with the
-- service-role client, which bypasses RLS); admins get read-only access for
-- the dashboard. No per-user folder convention — this is platform-level.

CREATE TABLE public.content_scheduler_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at              timestamptz NOT NULL DEFAULT now(),
  surface             text,                  -- 'blog' | 'social' | null (skip/error before a surface was chosen)
  product_focus       text,                  -- 'gradethread' | 'flipdesk' | null
  outcome             text NOT NULL,         -- 'success' | 'skip' | 'error'
  post_id             uuid,                  -- the blog/social post this tick produced, when any
  refilled_topics     integer NOT NULL DEFAULT 0,
  published_scheduled integer NOT NULL DEFAULT 0,
  error               text
);

-- Watchdog queries the most recent rows by time ("any non-error tick since
-- now()-3h?"), so order ran_at descending.
CREATE INDEX idx_content_scheduler_runs_ran_at
  ON public.content_scheduler_runs(ran_at DESC);

ALTER TABLE public.content_scheduler_runs ENABLE ROW LEVEL SECURITY;

-- Admin-read only. The service-role client (scheduler) bypasses RLS for writes,
-- so no INSERT policy is needed; mirrors the other content tables (00041) but
-- read-only since the scheduler is the sole writer.
CREATE POLICY "admins read content_scheduler_runs"
  ON public.content_scheduler_runs FOR SELECT
  USING (public.is_admin());
