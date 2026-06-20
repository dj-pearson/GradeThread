-- US-930: Newsletter admin console — the operator oversight + safety-brake
-- surface for the autonomous newsletter program.
--
-- The newsletter ENGINE (auto-build/QA/schedule/send) is delivered incrementally
-- by sibling stories; this migration adds the durable substrate the console
-- manages:
--   • newsletter_issues            — one row per program "issue" with the full
--                                    lifecycle the console drives:
--                                    draft → ready_for_qa → awaiting_review →
--                                    approved → sending → sent, plus a `blocked`
--                                    terminal the kill-switch / operator reject
--                                    lands on. Carries the editable subject +
--                                    sections, schedule, audience, QA results,
--                                    and live send-progress counters.
--   • newsletter_issue_recipients  — the per-issue resolved-recipient ledger that
--                                    powers the drill-in: who was resolved, who
--                                    was skipped (with a reason), and live send
--                                    progress.
--
-- Both are service-role only (RLS enabled, zero policies = deny-all): they are an
-- operator surface read/written exclusively by the role-gated /api/admin/newsletter
-- endpoints via the service-role edge client; the SPA never reads the raw rows.
--
-- Program-level controls (pause / require-approval) live in the system_settings
-- registry (00207) alongside the existing newsletter_send_paused kill-switch; the
-- platform-wide kill-switch is a feature_flags row (00096) so it halts instantly.
--
-- Additive + idempotent.

BEGIN;

-- ── Issue lifecycle ──────────────────────────────────────────────────────────
-- One row per newsletter issue. `status` is the lifecycle the console drives;
-- `sections` is the editable ordered content blocks (jsonb array of
-- {heading?, body, ctaLabel?, ctaUrl?}); `qa_results` is the automated QA report
-- (jsonb). created_by/approved_by reference the acting admin (NOT a tenant key —
-- this is an operator-owned program table, not user data).
CREATE TABLE IF NOT EXISTS public.newsletter_issues (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL DEFAULT 'Untitled issue',  -- internal label
  subject           text NOT NULL DEFAULT '',                -- email subject line
  preheader         text,                                    -- inbox preview text
  sections          jsonb NOT NULL DEFAULT '[]'::jsonb,      -- ordered content blocks
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN (
                        'draft', 'ready_for_qa', 'approved', 'awaiting_review',
                        'sending', 'sent', 'blocked'
                      )),
  audience          text NOT NULL DEFAULT 'all_confirmed',   -- segment key / 'all_confirmed'
  segment_id        uuid,                                    -- optional audience_segments ref
  scheduled_for     timestamptz,                             -- when the program will send it
  qa_results        jsonb NOT NULL DEFAULT '{}'::jsonb,      -- automated QA report
  recipients_total  integer NOT NULL DEFAULT 0,              -- resolved at send time
  sent_count        integer NOT NULL DEFAULT 0,
  skipped_count     integer NOT NULL DEFAULT 0,
  failed_count      integer NOT NULL DEFAULT 0,
  block_reason      text,                                    -- why blocked/rejected
  created_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  send_started_at   timestamptz,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.newsletter_issues IS
  'US-930: newsletter program issues with full draft→sent lifecycle, editable '
  'subject/sections, schedule, audience, QA results + send-progress counters. '
  'Operator surface — service-role only.';

CREATE INDEX IF NOT EXISTS newsletter_issues_status_idx
  ON public.newsletter_issues (status);
CREATE INDEX IF NOT EXISTS newsletter_issues_scheduled_idx
  ON public.newsletter_issues (scheduled_for);
CREATE INDEX IF NOT EXISTS newsletter_issues_created_idx
  ON public.newsletter_issues (created_at DESC);

CREATE OR REPLACE FUNCTION public.set_newsletter_issues_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_newsletter_issues_updated_at ON public.newsletter_issues;
CREATE TRIGGER trg_newsletter_issues_updated_at
  BEFORE UPDATE ON public.newsletter_issues
  FOR EACH ROW EXECUTE FUNCTION public.set_newsletter_issues_updated_at();

ALTER TABLE public.newsletter_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.newsletter_issues FROM anon, authenticated;

-- ── Per-issue resolved-recipient ledger (drill-in) ───────────────────────────
-- One row per resolved recipient of an issue. `status` mirrors campaign_recipients
-- semantics (pending/sent/skipped/failed); `skip_reason` records WHY a recipient
-- was skipped (opted-out / suppressed / no-account / frequency-capped). The
-- subscriber's linked account id is subscriber_user_id (deliberately NOT named
-- user_id — this is an operator program ledger, not tenant-owned data).
CREATE TABLE IF NOT EXISTS public.newsletter_issue_recipients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id            uuid NOT NULL REFERENCES public.newsletter_issues(id) ON DELETE CASCADE,
  email               text NOT NULL,
  subscriber_user_id  uuid,                                  -- linked account, if any
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  skip_reason         text,                                  -- why skipped (when status='skipped')
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.newsletter_issue_recipients IS
  'US-930: per-issue resolved-recipient ledger powering the console drill-in '
  '(resolved / skipped-with-reason / live send progress). Operator surface — '
  'service-role only.';

CREATE INDEX IF NOT EXISTS newsletter_issue_recipients_issue_idx
  ON public.newsletter_issue_recipients (issue_id);
CREATE INDEX IF NOT EXISTS newsletter_issue_recipients_status_idx
  ON public.newsletter_issue_recipients (issue_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_issue_recipients_unique_idx
  ON public.newsletter_issue_recipients (issue_id, email);

ALTER TABLE public.newsletter_issue_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.newsletter_issue_recipients FROM anon, authenticated;

-- ── Program controls (settings registry) ─────────────────────────────────────
-- The master "require human approval" toggle. The "pause program" master brake
-- reuses the existing newsletter_send_paused kill-switch (seeded 00278). `on
-- conflict do nothing` so an operator override is never clobbered on a re-run.
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'newsletter_require_approval',
    'true'::jsonb, 'bool', 'true'::jsonb,
    'US-930: when true, every newsletter issue must be human-approved (status awaiting_review → approved) before the program may send it; off lets QA-passing issues auto-approve.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

-- ── Platform-wide kill-switch (feature flag) ─────────────────────────────────
-- A dedicated feature_flags row so the whole newsletter program can be halted
-- instantly fleet-wide from the Feature Flags console or the newsletter console.
-- Seeded enabled; the program sender checks isFeatureEnabled('newsletter').
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'newsletter',
  true,
  'US-930: master kill-switch for the autonomous newsletter program. Disable to halt all newsletter sends instantly platform-wide.'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00279')
ON CONFLICT (version) DO NOTHING;
