-- US-924: Autonomous pre-send QA / guardrail gate — tunable thresholds.
--
-- The gate (lib/newsletter-qa.ts + newsletter-qa-job.ts) blocks an issue from
-- sending unless it clears the structural compliance checks + the AI editor
-- pass. Its thresholds live in the system_settings registry so operators retune
-- them (and toggle the AI editor / live link check) WITHOUT a deploy. The full
-- per-check QA report is already stored in the existing
-- newsletter_issues.qa_results jsonb column (00279), so no schema change is
-- needed — only these config rows.
--
-- Additive + idempotent.

BEGIN;

INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES
  (
    'newsletter_qa_spam_score_max',
    to_jsonb(5), 'number', to_jsonb(5), 'marketing',
    'US-924: cumulative spam score above which a newsletter issue is blocked by the pre-send QA gate (spammy phrases / ALL-CAPS / excessive punctuation in subject+preheader+body).'
  ),
  (
    'newsletter_qa_subject_max_length',
    to_jsonb(120), 'number', to_jsonb(120), 'marketing',
    'US-924: maximum subject-line length (chars) the pre-send QA gate allows.'
  ),
  (
    'newsletter_qa_preheader_max_length',
    to_jsonb(150), 'number', to_jsonb(150), 'marketing',
    'US-924: maximum preheader length (chars) the pre-send QA gate allows.'
  ),
  (
    'newsletter_qa_require_preference_center',
    'true'::jsonb, 'bool', 'true'::jsonb, 'marketing',
    'US-924: when true, the pre-send QA gate requires an email-preference-center link in the footer (in addition to one-click unsubscribe + postal address).'
  ),
  (
    'newsletter_qa_ai_editor_enabled',
    'true'::jsonb, 'bool', 'true'::jsonb, 'marketing',
    'US-924: when true, the pre-send QA gate runs the cheap-model AI editor pass (brand-voice + factual grounding); a hard hallucination flag blocks the send. Off skips the AI pass.'
  ),
  (
    'newsletter_qa_link_check_enabled',
    'true'::jsonb, 'bool', 'true'::jsonb, 'marketing',
    'US-924: when true, the pre-send QA gate performs a bounded live link-resolution pass (blocks only on a confirmed 4xx/5xx; transient network errors are inconclusive).'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00284')
ON CONFLICT (version) DO NOTHING;
