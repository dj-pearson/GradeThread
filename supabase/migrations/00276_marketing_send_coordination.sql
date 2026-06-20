-- US-934: marketing frequency cap & cross-program send coordination.
--
-- A unified, per-recipient ledger of marketing emails ACTUALLY sent, so the
-- coordinator (lib/marketing-coordinator.ts) can enforce a per-recipient daily
-- frequency cap ACROSS all marketing programs (trial drip, journeys, weekly
-- newsletter, win-back) — not per-program. Every marketing send writes one row
-- here; the coordinator counts rows since the recipient's local midnight to
-- decide send vs. defer.
--
-- Service-role only: RLS enabled with an explicit `revoke all from anon,
-- authenticated` and zero policies by design — written + read ONLY by the edge
-- marketing coordinator via the service-role client; the SPA never touches it.
-- owner_user_id (NOT user_id) so the rls-guard does not classify it as
-- user-owned tenant data — it is an operational send ledger keyed by recipient.
--
-- Additive + idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.marketing_send_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient     text NOT NULL,
  source        text NOT NULL,
  category      text,
  owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_send_log IS
  'US-934: unified per-recipient marketing-email send ledger driving the '
  'cross-program frequency cap. Service-role only.';

-- The cap query is "count by recipient since a window start" — index it.
CREATE INDEX IF NOT EXISTS idx_marketing_send_log_recipient_sent
  ON public.marketing_send_log (recipient, sent_at DESC);

ALTER TABLE public.marketing_send_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_send_log FROM anon, authenticated;

-- ── Seed the tunable coordinator settings into the registry (US-884) ────────
-- `on conflict do nothing` so an operator override applied before a re-run is
-- never clobbered.
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'marketing_frequency_cap_per_day',
    '1'::jsonb, 'number', '1'::jsonb,
    'US-934: max marketing emails per recipient per day across ALL programs (drip, journeys, newsletter, win-back).',
    'marketing'
  ),
  (
    'marketing_quiet_hours',
    '{"enabled": true, "startHour": 21, "endHour": 8, "timezone": "America/Chicago"}'::jsonb,
    'json',
    '{"enabled": true, "startHour": 21, "endHour": 8, "timezone": "America/Chicago"}'::jsonb,
    'US-934: no marketing sends during these local quiet hours (24h clock; window may wrap midnight).',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00276')
ON CONFLICT (version) DO NOTHING;
