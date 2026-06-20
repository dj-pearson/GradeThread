-- US-923: Make.com kickoff trigger + webhook contract for the autonomous newsletter.
--
-- The ONE allowed external touchpoint (POST /api/newsletter/scheduler/tick) starts
-- the weekly run on schedule; everything after the trigger is automated. On issue
-- lifecycle events (created, sent) it fires a signed, retried notification to a
-- configurable Make.com webhook URL so downstream automation can react.
--
-- This migration adds:
--   1. newsletter_webhook_log — per-attempt delivery audit (mirrors
--      content_webhook_log): every send/retry of a newsletter lifecycle webhook is
--      logged with its HTTP status + outcome. Service-role only (RLS on, zero
--      policies, explicit REVOKE) — read only by the operator console via the
--      service-role edge client; the SPA never reads it. No user_id (an operator
--      log keyed by issue_id), so the rls-guard tenant sweep doesn't cover it.
--   2. newsletter_make_webhook_url — the configurable downstream Make.com webhook
--      URL, in the settings registry so it changes WITHOUT a deploy. Empty = the
--      notification is skipped (no destination configured).
--
-- Additive + idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.newsletter_webhook_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event           text NOT NULL,            -- issue.created | issue.sent
  issue_id        uuid,                     -- the newsletter issue (grouping key)
  target_url      text NOT NULL,
  payload         jsonb NOT NULL,
  attempt_no      integer NOT NULL,
  http_status     integer,
  response_body   text,
  succeeded       boolean NOT NULL DEFAULT false,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_webhook_log_event_created_at
  ON public.newsletter_webhook_log(event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_newsletter_webhook_log_issue
  ON public.newsletter_webhook_log(issue_id, created_at DESC);

-- Service-role only: RLS enabled with zero policies + an explicit revoke, so
-- anon/authenticated get nothing and only the edge service-role client (which
-- bypasses RLS) reads/writes it.
ALTER TABLE public.newsletter_webhook_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.newsletter_webhook_log FROM anon, authenticated;

-- Configurable downstream Make.com webhook URL (empty = disabled).
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES
  (
    'newsletter_make_webhook_url',
    to_jsonb(''::text), 'string', to_jsonb(''::text), 'marketing',
    'US-923: downstream Make.com (or any) webhook URL the autonomous newsletter pings on issue lifecycle events (issue.created / issue.sent). The POST body is HMAC-signed with NEWSLETTER_WEBHOOK_SIGNING_SECRET (X-Newsletter-Signature header) and retried (0s/5s/30s); each attempt is logged to newsletter_webhook_log. Empty = no downstream notification.'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00285')
ON CONFLICT (version) DO NOTHING;
