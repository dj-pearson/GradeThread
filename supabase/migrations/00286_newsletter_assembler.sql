-- US-922: Autonomous weekly issue assembler — durable substrate.
--
-- The assembler (lib/newsletter-assembler.ts) is the single orchestrator that
-- builds the week's issue end-to-end with zero human input: gather unsent
-- "what's new" changelog entries → pick a deduped educational topic → generate
-- copy → generate imagery → render HTML+plaintext → persist a complete
-- newsletter_issues row (status='ready_for_qa'). It must be IDEMPOTENT (one
-- issue per period) and RESUMABLE (each sub-step's status recorded on the issue),
-- so this migration adds:
--   • period_key            — the cadence-period key; a partial UNIQUE index
--                             enforces at-most-one issue per period (idempotency).
--   • build_steps           — per-step status ledger {step: {status, at, detail}}
--                             so a failed sub-step resumes on the next tick.
--   • featured_content_ids  — content_history_index ids featured as "what's new"
--                             in this issue; future issues exclude these (unsent
--                             tracking / dedup).
--   • product_focus         — which product the issue leans toward (gradethread /
--                             flipdesk / both) for audience balancing.
--   • hero_image_url        — generated issue imagery (best-effort).
--   • body_html / body_text — the rendered artifacts (HTML + plaintext).
--
-- Plus the newsletter assembler settings singleton (mirrors content_settings —
-- registry-backed config) so cadence/audiences/max-images/max-sections retune
-- WITHOUT a deploy.
--
-- Additive + idempotent.

BEGIN;

ALTER TABLE public.newsletter_issues
  ADD COLUMN IF NOT EXISTS period_key           text,
  ADD COLUMN IF NOT EXISTS build_steps          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS featured_content_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS product_focus        text  NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS hero_image_url       text,
  ADD COLUMN IF NOT EXISTS body_html            text,
  ADD COLUMN IF NOT EXISTS body_text            text;

COMMENT ON COLUMN public.newsletter_issues.period_key IS
  'US-922: cadence-period key (floor(nowMs / cadencePeriodMs)); a partial UNIQUE '
  'index makes the autonomous assembler idempotent — at most one issue per period.';
COMMENT ON COLUMN public.newsletter_issues.build_steps IS
  'US-922: per-step assembly status ledger {step: {status,at,detail}} so a failed '
  'sub-step is resumable on the next tick without re-spending on completed steps.';
COMMENT ON COLUMN public.newsletter_issues.featured_content_ids IS
  'US-922: content_history_index ids featured as "what''s new" in this issue; future '
  'issues exclude these so the same update is never re-sent.';

-- Idempotency: at most one issue per cadence period. Partial so legacy rows and
-- manual drafts (period_key NULL) are never constrained.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_issues_period_key_idx
  ON public.newsletter_issues (period_key)
  WHERE period_key IS NOT NULL;

-- ── Newsletter assembler settings singleton (mirrors content_settings) ───────
-- Registry-backed so operators retune cadence/audiences/imagery/sections without
-- a deploy. `on conflict do nothing` so an operator override is never clobbered.
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'newsletter_assembler_enabled',
    'true'::jsonb, 'bool', 'true'::jsonb,
    'US-922: master toggle for the autonomous issue assembler. When false the kickoff tick scaffolds nothing (existing issues still advance/dispatch).',
    'marketing'
  ),
  (
    'newsletter_assembler_max_images',
    to_jsonb(1), 'number', to_jsonb(1),
    'US-922: maximum AI-generated hero images per assembled issue (0 disables imagery). Each image is a metered AI image-model call.',
    'marketing'
  ),
  (
    'newsletter_assembler_max_sections',
    to_jsonb(5), 'number', to_jsonb(5),
    'US-922: maximum content sections the assembler asks the copywriter to produce (excluding the what''s-new block).',
    'marketing'
  ),
  (
    'newsletter_assembler_audiences',
    '["all_confirmed"]'::jsonb, 'json', '["all_confirmed"]'::jsonb,
    'US-922: audience keys the assembler rotates across (newsletter_issues.audience). Each maps to a resolved recipient segment at send time.',
    'marketing'
  ),
  (
    'newsletter_assembler_changelog_lookback_days',
    to_jsonb(45), 'number', to_jsonb(45),
    'US-922: how far back (days) the assembler scans content_history_index for unsent "what''s new" entries to feature.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00286')
ON CONFLICT (version) DO NOTHING;
