-- US-921: Per-recipient personalization blocks.
--
-- The weekly newsletter can now inject a per-recipient "your week on GradeThread"
-- recap (items graded / listed / sold this week, slow-movers) plus a tailored
-- next-best-action CTA (e.g. "you have 3 ungraded items", "your trial ends in 2
-- days"). The dynamic blocks are RESOLVED at send time from existing data via a
-- single batched query per send batch (lib/newsletter-personalization-job.ts) and
-- TOKEN-SUBSTITUTED into the pre-rendered template per recipient — no AI is
-- re-run per user, so cost stays O(1) per issue.
--
-- This migration adds the per-issue toggle so some broadcasts can opt out of
-- personalization (AC6) and seeds its global default + the slow-mover threshold
-- the resolver reads.

BEGIN;

ALTER TABLE public.newsletter_issues
  -- AC6: personalization can be toggled per issue (default on; a non-personalized
  -- broadcast sets this false and every recipient gets the identical evergreen body).
  ADD COLUMN IF NOT EXISTS personalize boolean NOT NULL DEFAULT true;

-- Settings registry: global default + the slow-mover window the resolver uses to
-- decide which active listings count as "haven't sold in a while".
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'newsletter_personalization_enabled',
    to_jsonb(true), 'bool', to_jsonb(true),
    'US-921: master default for per-recipient newsletter personalization. A per-issue personalize=false still overrides this to off for that broadcast.',
    'marketing'
  ),
  (
    'newsletter_personalization_slow_mover_days',
    to_jsonb(30), 'number', to_jsonb(30),
    'US-921: an active listing older than this many days counts as a "slow-mover" in the per-recipient newsletter recap / CTA.',
    'marketing'
  ),
  (
    'newsletter_personalization_trial_soon_days',
    to_jsonb(3), 'number', to_jsonb(3),
    'US-921: a trialist with this many days (or fewer) left gets the "your trial ends in N days" tailored CTA in the newsletter.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00287')
ON CONFLICT (version) DO NOTHING;
