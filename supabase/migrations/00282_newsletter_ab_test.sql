-- US-927: Subject-line A/B testing with autonomous winner selection for the
-- newsletter program.
--
-- The copywriter (sibling story) produces 2-3 subject variants per issue. The
-- sender sends a configurable TEST fraction across those variants (the A/B
-- holdout), waits a measurement window, then sends the WINNING subject (by open,
-- or click for CTA tests) to the remainder — fully autonomously, with the winner
-- visible/overridable in the admin console.
--
-- This migration adds the durable substrate:
--   • newsletter_issues gains the subject-variant catalog + A/B test state
--     (metric, test fraction, measurement window, phase, winner + winner source,
--     test-started timestamp) so the two-phase send is resumable + idempotent.
--   • newsletter_issue_recipients gains per-recipient variant assignment +
--     holdout flag so per-variant open/click rolls up for winner selection and
--     the console drill-in can show who got which subject.
--   • system_settings registry keys: the A/B CONFIG (enable, default test
--     fraction, measurement window, min sample) operators tune without a deploy.
--
-- Additive + idempotent.

BEGIN;

-- ── Issue A/B state ──────────────────────────────────────────────────────────
ALTER TABLE public.newsletter_issues
  ADD COLUMN IF NOT EXISTS subject_variants     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ab_metric            text    NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS ab_test_fraction     numeric,   -- per-issue override (null → setting)
  ADD COLUMN IF NOT EXISTS ab_measurement_hours integer,   -- per-issue override (null → setting)
  ADD COLUMN IF NOT EXISTS ab_phase             text    NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS ab_test_started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS ab_winner_variant    text,      -- chosen variant id
  ADD COLUMN IF NOT EXISTS ab_winner_source     text;      -- auto / operator / fallback

ALTER TABLE public.newsletter_issues
  DROP CONSTRAINT IF EXISTS newsletter_issues_ab_metric_check;
ALTER TABLE public.newsletter_issues
  ADD CONSTRAINT newsletter_issues_ab_metric_check
  CHECK (ab_metric IN ('open', 'click'));

ALTER TABLE public.newsletter_issues
  DROP CONSTRAINT IF EXISTS newsletter_issues_ab_phase_check;
ALTER TABLE public.newsletter_issues
  ADD CONSTRAINT newsletter_issues_ab_phase_check
  CHECK (ab_phase IN ('none', 'testing', 'completed'));

ALTER TABLE public.newsletter_issues
  DROP CONSTRAINT IF EXISTS newsletter_issues_ab_winner_source_check;
ALTER TABLE public.newsletter_issues
  ADD CONSTRAINT newsletter_issues_ab_winner_source_check
  CHECK (ab_winner_source IS NULL OR ab_winner_source IN ('auto', 'operator', 'fallback'));

COMMENT ON COLUMN public.newsletter_issues.subject_variants IS
  'US-927: ordered subject-line variants [{id, subject, label?}] the A/B test sends across the holdout.';
COMMENT ON COLUMN public.newsletter_issues.ab_phase IS
  'US-927: A/B lifecycle — none (no test), testing (holdout sent, measuring), completed (winner sent to remainder).';
COMMENT ON COLUMN public.newsletter_issues.ab_winner_source IS
  'US-927: how the winner was chosen — auto (engagement), operator (manual override), fallback (below min sample → default variant).';

-- Scan testing issues whose measurement window may have elapsed cheaply.
CREATE INDEX IF NOT EXISTS newsletter_issues_ab_phase_idx
  ON public.newsletter_issues (ab_phase, ab_test_started_at);

-- ── Per-recipient variant assignment ─────────────────────────────────────────
ALTER TABLE public.newsletter_issue_recipients
  ADD COLUMN IF NOT EXISTS variant       text,                    -- assigned subject-variant id
  ADD COLUMN IF NOT EXISTS is_ab_holdout boolean NOT NULL DEFAULT false; -- part of the A/B test sample

COMMENT ON COLUMN public.newsletter_issue_recipients.variant IS
  'US-927: subject-variant id this recipient was sent (the winner for the remainder).';
COMMENT ON COLUMN public.newsletter_issue_recipients.is_ab_holdout IS
  'US-927: true for the A/B test sample (engagement on these rows decides the winner).';

-- Roll per-variant engagement up for winner selection.
CREATE INDEX IF NOT EXISTS newsletter_issue_recipients_variant_idx
  ON public.newsletter_issue_recipients (issue_id, variant);

-- ── A/B config (settings registry) ───────────────────────────────────────────
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES
  (
    'newsletter_ab_test_enabled',
    'true'::jsonb, 'bool', 'true'::jsonb, 'marketing',
    'US-927: when true, issues carrying 2+ subject variants run an A/B test (holdout → winner → remainder); off sends the primary subject to everyone.'
  ),
  (
    'newsletter_ab_test_fraction',
    to_jsonb(0.2::numeric), 'number', to_jsonb(0.2::numeric), 'marketing',
    'US-927: fraction (0–1) of the resolved list used as the A/B test holdout (split across variants). The winning subject goes to the remaining (1−fraction).'
  ),
  (
    'newsletter_ab_measurement_hours',
    to_jsonb(4), 'number', to_jsonb(4), 'marketing',
    'US-927: hours to measure open/click on the A/B holdout before the winner is auto-selected and sent to the remainder.'
  ),
  (
    'newsletter_ab_min_sample',
    to_jsonb(50), 'number', to_jsonb(50), 'marketing',
    'US-927: minimum sends PER VARIANT before its open/click rate is trusted for winner selection. Below it the test falls back to the default (first) variant — no spurious winners on tiny lists.'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00282')
ON CONFLICT (version) DO NOTHING;
