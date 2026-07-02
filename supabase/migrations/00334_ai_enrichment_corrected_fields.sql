-- US-1531: extraction correction-capture loop.
--
-- ai_enrichment_log.accepted_fields already records WHICH AI-suggested fields a
-- user accepted, but not what they changed them TO. Add corrected_fields —
-- {field: {suggested, final}} — captured when a user edits an AI-filled field
-- within the review window, so we can measure per-field extraction accuracy
-- (e.g. "style" is wrong 40% of the time on Nike items) and fix the prompt.
-- This is the measurement baseline for the identification stories (US-1526..1530).

ALTER TABLE public.ai_enrichment_log
  ADD COLUMN IF NOT EXISTS corrected_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.ai_enrichment_log.corrected_fields IS
  'US-1531: {field: {suggested, final}} pairs captured when a user edits an AI-filled field within the review window. Powers per-field suggestion->correction accuracy analytics.';

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00334') ON CONFLICT DO NOTHING;
