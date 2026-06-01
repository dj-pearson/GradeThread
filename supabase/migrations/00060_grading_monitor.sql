-- Grading regression monitor (US-327).
--
-- The eval gate (migration 00050) catches a BAD prompt before it goes live.
-- This adds the other half of "self-improving over time": a scheduled job that
-- re-checks the LIVE grader on its own and records whether quality is holding,
-- so drift is caught autonomously instead of only when someone opens the admin
-- dashboard. Each run persists one immutable row here; the cron raises an alert
-- (email + audit log) when a threshold is breached.

CREATE TABLE IF NOT EXISTS public.grading_monitor_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'scheduled' (cron) or 'manual' (admin-triggered, future use).
  trigger       text NOT NULL DEFAULT 'scheduled'
                  CHECK (trigger IN ('scheduled', 'manual')),
  -- Worst severity across this run's alerts: 'ok' | 'warn' | 'critical'.
  severity      text NOT NULL DEFAULT 'ok'
                  CHECK (severity IN ('ok', 'warn', 'critical')),
  -- Scheduled-eval result against the golden set for the live prompt version
  -- ({ ran, prompt_version_name, mean_absolute_error, agreement_rate, passed,
  --   regression_vs_baseline, baseline_mae, skipped_reason }).
  eval          jsonb NOT NULL DEFAULT '{}',
  -- Production-derived metrics ({ human_reviews, agreement_rate,
  --   mean_absolute_error, intentional_misread_rate, graded_sales,
  --   dispute_rate }).
  production    jsonb NOT NULL DEFAULT '{}',
  -- Array of { code, severity, metric, value, threshold, message }.
  alerts        jsonb NOT NULL DEFAULT '[]',
  -- Distinct alert codes raised this run, for cheap dedup/cooldown queries.
  alert_codes   text[] NOT NULL DEFAULT '{}',
  -- Did this run actually dispatch a notification (vs. suppressed by cooldown)?
  alerted       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grading_monitor_runs_created_at
  ON public.grading_monitor_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_grading_monitor_runs_alerted
  ON public.grading_monitor_runs(alerted, created_at DESC) WHERE alerted = true;

-- ── RLS: admin read; writes come from the service role (bypasses RLS) ──
ALTER TABLE public.grading_monitor_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read monitor runs"
  ON public.grading_monitor_runs FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins write monitor runs"
  ON public.grading_monitor_runs FOR INSERT
  WITH CHECK (public.is_admin());
