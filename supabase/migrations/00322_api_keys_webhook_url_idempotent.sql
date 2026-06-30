-- Re-add api_keys.webhook_url idempotently (fixes prod schema drift).
--
-- The original 00005_api_keys_webhook_url.sql predates the US-1108 migration
-- conventions: its `ALTER TABLE ... ADD COLUMN webhook_url` was NOT idempotent
-- and it carried no self-record footer, so it never landed in
-- public.applied_migrations. In prod the column is missing entirely, and every
-- finalized grade logs:
--
--   [Webhook] Failed to fetch API keys for webhook delivery:
--     { code: "42703", message: "column api_keys.webhook_url does not exist" }
--
-- That query (lib/webhook-delivery.ts) selects + filters on webhook_url, so the
-- developer-webhook delivery on grade completion silently no-ops on every grade.
-- This migration restores the column (and the owner-update policy the webhook
-- config endpoint needs) idempotently so a fresh apply and a drifted prod both
-- converge.

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS webhook_url text;

-- Owner-update policy (needed for PATCH /api/v1/webhook). CREATE POLICY has no
-- IF NOT EXISTS form, so drop-then-create keeps this idempotent.
DROP POLICY IF EXISTS "Users can update own API keys" ON public.api_keys;
CREATE POLICY "Users can update own API keys"
  ON public.api_keys FOR UPDATE
  USING (auth.uid() = user_id);

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00322') ON CONFLICT DO NOTHING;
