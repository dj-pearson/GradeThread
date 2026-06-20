-- US-926: Weekly scheduler + send-time optimization for the autonomous newsletter.
--
-- The dispatch engine (lib/newsletter-dispatch-job.ts, cron /api/jobs/newsletter-
-- dispatch) assigns each approved issue a send window (configured weekday/hour in a
-- configured timezone) and releases due issues through the gated sender — applying
-- a per-period cadence guard and, optionally, per-recipient send-time optimization.
-- Every knob is config-driven via the settings registry so the send day/hour, the
-- timezone, the cadence period, STO, and a holiday/quiet-period pause all change
-- WITHOUT a code deploy (AC4 + AC6).
--
-- No new tables/columns: the engine reuses newsletter_issues.scheduled_for (00279)
-- for the window and newsletter_issue_recipients.{sent_at,opened_at} (00279/00281)
-- for the cadence clock + STO open-hour history. This migration only seeds the
-- config knobs.
--
-- Additive + idempotent.

BEGIN;

INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES
  (
    'newsletter_schedule_weekday',
    to_jsonb(2), 'number', to_jsonb(2), 'marketing',
    'US-926: day of week the weekly newsletter sends — 0=Sunday … 6=Saturday (default 2=Tuesday). The scheduler sets each approved issue''s send window to the next occurrence at newsletter_schedule_hour in newsletter_schedule_timezone.'
  ),
  (
    'newsletter_schedule_hour',
    to_jsonb(14), 'number', to_jsonb(14), 'marketing',
    'US-926: hour of day (0–23) in newsletter_schedule_timezone the weekly send window opens (default 14).'
  ),
  (
    'newsletter_schedule_timezone',
    to_jsonb('UTC'::text), 'string', to_jsonb('UTC'::text), 'marketing',
    'US-926: IANA timezone the weekday/hour are interpreted in (e.g. America/New_York). DST-aware; defaults to UTC. Invalid zones fall back to UTC.'
  ),
  (
    'newsletter_cadence_period_days',
    to_jsonb(7), 'number', to_jsonb(7), 'marketing',
    'US-926: cadence guard — no recipient receives more than one newsletter within this many days, even across dispatch re-runs (default 7).'
  ),
  (
    'newsletter_send_time_optimization_enabled',
    'false'::jsonb, 'bool', 'false'::jsonb, 'marketing',
    'US-926: when true, stagger each recipient toward their historically-best open hour within the send window (safe default = window open when no history). Off sends the whole list at the window.'
  ),
  (
    'newsletter_sto_window_hours',
    to_jsonb(12), 'number', to_jsonb(12), 'marketing',
    'US-926: hours after the send window opens across which send-time optimization may spread sends. After this span every remaining recipient is flushed and the issue is marked sent (default 12).'
  ),
  (
    'newsletter_quiet_period_until',
    to_jsonb(''::text), 'string', to_jsonb(''::text), 'marketing',
    'US-926: holiday/quiet-period pause — while now < this ISO instant, dispatch is skipped entirely (a week is cleanly skipped) WITHOUT touching the cadence clock. Empty = no quiet period.'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00283')
ON CONFLICT (version) DO NOTHING;
