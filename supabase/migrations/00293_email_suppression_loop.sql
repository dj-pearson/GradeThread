-- US-914: SES bounce/complaint suppression loop.
--
-- Builds on the US-1057 suppression list (00245) to make hands-off autonomous
-- sending safe: hard bounces and spam complaints auto-suppress an address so the
-- sender never repeatedly mails bad/angry recipients (protecting SES sender
-- reputation), every send path skips suppressed addresses, and a complaint flips
-- the user's marketing consent off + can auto-pause the newsletter program when
-- the rolling complaint rate breaches a configurable threshold.
--
-- This migration:
--   1. Extends email_suppressions to the US-914 shape (source + notes columns,
--      reason enum = hard_bounce|complaint|manual|unsubscribe_all). Existing
--      'bounce' rows are migrated to 'hard_bounce'.
--   2. Adds a 'skipped' status (+ skip_reason) to email_deliveries so a send
--      skipped for suppression is recorded with its reason, not silently dropped.
--   3. Seeds the rolling-complaint-rate alert/auto-pause config into the settings
--      registry (tunable without a deploy).
-- Idempotent throughout (IF EXISTS / IF NOT EXISTS / ON CONFLICT DO NOTHING).

BEGIN;

-- ── 1. email_suppressions → US-914 shape ────────────────────────────────────

ALTER TABLE public.email_suppressions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ses';

ALTER TABLE public.email_suppressions
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN public.email_suppressions.source IS
  'US-914: where the suppression came from (ses, manual, unsubscribe, …).';
COMMENT ON COLUMN public.email_suppressions.notes IS
  'US-914: free-form context (SES feedback type, operator note, …).';

-- Migrate legacy 'bounce' rows to the US-914 'hard_bounce' value BEFORE swapping
-- the check constraint so the new constraint validates cleanly.
UPDATE public.email_suppressions SET reason = 'hard_bounce' WHERE reason = 'bounce';

-- Replace the reason check with the US-914 enum.
ALTER TABLE public.email_suppressions
  DROP CONSTRAINT IF EXISTS email_suppressions_reason_check;
ALTER TABLE public.email_suppressions
  ADD CONSTRAINT email_suppressions_reason_check
  CHECK (reason IN ('hard_bounce', 'complaint', 'manual', 'unsubscribe_all'));

-- ── 2. email_deliveries: a 'skipped' terminal state ─────────────────────────

ALTER TABLE public.email_deliveries
  ADD COLUMN IF NOT EXISTS skip_reason text;

COMMENT ON COLUMN public.email_deliveries.skip_reason IS
  'US-914: why a delivery was skipped (e.g. suppressed:hard_bounce). Set with status=skipped.';

ALTER TABLE public.email_deliveries
  DROP CONSTRAINT IF EXISTS email_deliveries_status_check;
ALTER TABLE public.email_deliveries
  ADD CONSTRAINT email_deliveries_status_check
  CHECK (status IN ('pending', 'sent', 'dead_letter', 'skipped'));

-- ── 3. Rolling-complaint-rate alert / auto-pause config ─────────────────────
-- value_type is one of number|bool|string|json (00208) — note 'bool'.

INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'marketing_complaint_rate_threshold',
    '0.001'::jsonb, 'number', '0.001'::jsonb,
    'US-914: rolling spam-complaint rate (complaints / marketing sends in the window) above which an ops alert is raised. AWS flags accounts above 0.1% (0.001).',
    'marketing'
  ),
  (
    'marketing_complaint_rate_window_hours',
    '24'::jsonb, 'number', '24'::jsonb,
    'US-914: window (hours) over which the rolling complaint rate is computed.',
    'marketing'
  ),
  (
    'marketing_complaint_rate_min_volume',
    '500'::jsonb, 'number', '500'::jsonb,
    'US-914: minimum marketing sends in the window before the complaint rate is acted on (avoids alerting on a tiny sample).',
    'marketing'
  ),
  (
    'marketing_complaint_auto_pause',
    'false'::jsonb, 'bool', 'false'::jsonb,
    'US-914: when true, a complaint that pushes the rolling rate over marketing_complaint_rate_threshold auto-pauses the newsletter program (sets newsletter_send_paused). Off by default — alert only.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00293')
ON CONFLICT (version) DO NOTHING;
