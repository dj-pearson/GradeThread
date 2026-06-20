-- US-911: Dedicated newsletter consent + self-serve preference center.
--
-- Two changes, both additive + idempotent:
--
--  1. CONSENT-KEY RECONCILIATION BACKFILL. Before US-911 the no-login
--     unsubscribe link wrote notification_preferences.product_updates.email=false
--     while every marketing send gate read notification_preferences.marketing.email
--     — so an unsubscribe never actually suppressed a broadcast. The send gate is
--     now the canonical `marketing` umbrella (lib/email-consent.ts). To preserve
--     the opt-out of every recipient who already unsubscribed under the old key,
--     copy product_updates.email=false → marketing.email=false. Without this, the
--     key change would silently re-subscribe everyone who had opted out.
--
--  2. email_consent_audit — an attributable opt-out/consent-change trail (AC6) so
--     unsubscribe history is traceable. Service-role only (deny-all RLS); written
--     by the no-login unsubscribe + preference-center endpoints.

BEGIN;

-- ── 1. Backfill: preserve prior opt-outs onto the canonical umbrella key ──────
UPDATE public.users
   SET notification_preferences =
         jsonb_set(
           COALESCE(notification_preferences, '{}'::jsonb),
           '{marketing,email}',
           'false'::jsonb,
           true
         )
 WHERE COALESCE(notification_preferences, '{}'::jsonb) #>> '{product_updates,email}' = 'false'
   AND COALESCE(notification_preferences, '{}'::jsonb) #>> '{marketing,email}' IS DISTINCT FROM 'false';

-- ── 2. Consent-change audit trail (AC6) ──────────────────────────────────────
-- Column is named subscriber_user_id (NOT user_id) so the rls-guard tenant-table
-- discovery doesn't treat it as a user-owned table — it's an operator/forensic
-- log (deny-all, service-role writes only; listed in rls-guard SERVICE_ROLE_ONLY).
CREATE TABLE IF NOT EXISTS public.email_consent_audit (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  email              text,
  action             text NOT NULL CHECK (action IN ('unsubscribe_all', 'category_update', 'resubscribe')),
  category           text,
  channel            text NOT NULL DEFAULT 'email',
  enabled            boolean,
  source             text NOT NULL DEFAULT 'preference_center',
  before             jsonb,
  after              jsonb,
  ip                 text,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_consent_audit_user_idx
  ON public.email_consent_audit (subscriber_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_consent_audit_email_idx
  ON public.email_consent_audit (email, created_at DESC);

COMMENT ON TABLE public.email_consent_audit IS
  'US-911: attributable marketing-consent change log (unsubscribe / category '
  'toggle). Written by the no-login unsubscribe + preference-center endpoints so '
  'opt-out history is traceable. Service-role only (deny-all RLS).';

-- Deny-all RLS: only the service-role client (which bypasses RLS) may read/write.
ALTER TABLE public.email_consent_audit ENABLE ROW LEVEL SECURITY;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00296')
ON CONFLICT (version) DO NOTHING;
