-- US-928: Closed-loop self-tuning from engagement for the autonomous newsletter.
--
-- The newsletter program (US-930 console + sibling engine stories) picks a topic,
-- writes a subject, and schedules a send hour. This migration adds the durable
-- substrate that lets an analysis job feed open/click/unsubscribe engagement back
-- into those choices so the program gets smarter over time:
--
--   • newsletter_issues gains PROVENANCE columns (pillar / angle / subject_style /
--     send_hour) so every issue records WHICH topic + subject style + hour it used.
--     The analysis job attributes engagement to these dimensions; the assembler
--     reads the resulting weights to bias the next issue.
--   • newsletter_issue_recipients gains the per-recipient ENGAGEMENT signals
--     (opened_at / clicked_at / unsubscribed_at) the analysis job aggregates into
--     per-issue / per-topic / per-style / per-hour rates. (Population — open/click
--     pixels + unsubscribe stamping — is wired by the tracking sibling; the column
--     home + aggregation live here so the closed loop is data-driven by construction.)
--   • system_settings registry keys: the tuning CONFIG (exploration floor, unsub
--     ceiling, min sample, enable flag) operators can tune without a deploy, plus
--     the COMPUTED weight stores the job writes and the assembler reads, plus the
--     latest recommendations snapshot the admin console surfaces (AC4).
--
-- Additive + idempotent.

BEGIN;

-- ── Issue provenance dimensions ──────────────────────────────────────────────
ALTER TABLE public.newsletter_issues
  ADD COLUMN IF NOT EXISTS pillar        text,   -- content pillar (topic family)
  ADD COLUMN IF NOT EXISTS angle         text,   -- topic angle within the pillar
  ADD COLUMN IF NOT EXISTS subject_style text,   -- subject-line style used (benefit/curiosity/…)
  ADD COLUMN IF NOT EXISTS send_hour     smallint; -- UTC hour (0–23) the issue was scheduled to send

ALTER TABLE public.newsletter_issues
  DROP CONSTRAINT IF EXISTS newsletter_issues_send_hour_check;
ALTER TABLE public.newsletter_issues
  ADD CONSTRAINT newsletter_issues_send_hour_check
  CHECK (send_hour IS NULL OR (send_hour >= 0 AND send_hour <= 23));

COMMENT ON COLUMN public.newsletter_issues.pillar IS
  'US-928: content pillar this issue used — the topic dimension the self-tuning loop weights.';
COMMENT ON COLUMN public.newsletter_issues.subject_style IS
  'US-928: subject-line style used — the dimension subject-variant generation is nudged toward.';
COMMENT ON COLUMN public.newsletter_issues.send_hour IS
  'US-928: UTC send hour — the dimension send-time optimization consumes.';

-- Index the topic dimension so the analysis job can scan recently-sent issues by topic cheaply.
CREATE INDEX IF NOT EXISTS newsletter_issues_pillar_idx
  ON public.newsletter_issues (pillar);

-- ── Per-recipient engagement signals ─────────────────────────────────────────
ALTER TABLE public.newsletter_issue_recipients
  ADD COLUMN IF NOT EXISTS opened_at       timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_at      timestamptz,
  ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;

COMMENT ON COLUMN public.newsletter_issue_recipients.opened_at IS
  'US-928: when this recipient opened the issue (engagement signal aggregated by the self-tuning job).';

-- ── Tuning config + computed weight stores (settings registry) ───────────────
-- Config: operators tune these in /admin/ops/settings without a deploy.
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES
  (
    'newsletter_tuning_enabled',
    'true'::jsonb, 'bool', 'true'::jsonb, 'marketing',
    'US-928: when true, the newsletter self-tuning analysis job recomputes topic/subject/send-hour weights from engagement, and the assembler biases selection by them. Off freezes the current weights.'
  ),
  (
    'newsletter_tuning_min_sample',
    to_jsonb(50), 'number', to_jsonb(50), 'marketing',
    'US-928: minimum sends before a topic/subject-style/hour rate is trusted for winner selection (below it the dimension only earns exploration airtime).'
  ),
  (
    'newsletter_tuning_exploration_floor',
    to_jsonb(0.15::numeric), 'number', to_jsonb(0.15::numeric), 'marketing',
    'US-928: fraction (0–1) of selection weight always reserved across non-paused topics so under-tested ones keep airtime (prevents runaway narrowing).'
  ),
  (
    'newsletter_tuning_unsub_ceiling',
    to_jsonb(0.005::numeric), 'number', to_jsonb(0.005::numeric), 'marketing',
    'US-928: unsubscribe rate above which a sufficiently-sampled topic is PAUSED (weight 0) in the next selection.'
  ),
  -- Computed stores: written by the analysis job, read by the assembler. Seeded empty.
  (
    'newsletter_topic_weights',
    '{}'::jsonb, 'json', '{}'::jsonb, 'marketing',
    'US-928: computed topic-id → selection weight (0–100) the assembler reads to bias topic selection. Written by the newsletter-tuning job.'
  ),
  (
    'newsletter_subject_style_weights',
    '{}'::jsonb, 'json', '{}'::jsonb, 'marketing',
    'US-928: computed subject-style → weight the assembler reads to nudge subject-variant generation toward winning styles.'
  ),
  (
    'newsletter_send_hour_stats',
    '{}'::jsonb, 'json', '{}'::jsonb, 'marketing',
    'US-928: computed { bestHour, scores[] } per-hour engagement the assembler reads for send-time optimization.'
  ),
  (
    'newsletter_tuning_recommendations',
    '{}'::jsonb, 'json', '{}'::jsonb, 'marketing',
    'US-928: latest self-tuning recommendations snapshot (per-topic/style/hour scores + paused topics + computedAt) the admin console surfaces for transparency/override.'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00281')
ON CONFLICT (version) DO NOTHING;
