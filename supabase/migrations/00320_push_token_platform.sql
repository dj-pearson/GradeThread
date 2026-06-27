-- 00320_push_token_platform.sql
--
-- Android backend dep (ANDROID_CONVERSION_PLAN.md): the native Android client
-- registers FCM device tokens, not APNs ones. push_device_tokens (US-187/626)
-- was iOS/APNs-only; add a `platform` discriminator so the fan-out
-- (lib/apns.ts sendPushToUser) can route each token to the right transport —
-- APNs for 'apns' rows, FCM for 'fcm' rows.
--
-- Every existing row is an APNs/iOS token, so the column defaults to 'apns' and
-- the backfill is a no-op (the default applies to existing rows on add). The
-- `environment` column (dev/prod APNs gateway) is meaningless for FCM, where a
-- single endpoint serves both — FCM rows just carry 'production'.
--
-- Idempotent (US-1108): ADD COLUMN IF NOT EXISTS + self-record footer.

ALTER TABLE public.push_device_tokens
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'apns'
    CHECK (platform IN ('apns', 'fcm'));

COMMENT ON COLUMN public.push_device_tokens.platform IS
  'Push transport for this token: ''apns'' (iOS, default) or ''fcm'' (Android). '
  'The fan-out routes each row to the matching sender.';

-- Partial index so the FCM fan-out can scan only Android tokens cheaply once
-- both platforms are in play.
CREATE INDEX IF NOT EXISTS idx_push_device_tokens_platform
  ON public.push_device_tokens (platform);

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00320') ON CONFLICT DO NOTHING;
