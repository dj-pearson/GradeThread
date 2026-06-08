-- Push device tokens for iOS (US-187). One row per (user, device,
-- environment) — a user with iPhone + iPad has two rows; the server
-- fans out per row when emitting an APNs push.
--
-- Tokens are hex-encoded strings as returned by iOS's
-- didRegisterForRemoteNotificationsWithDeviceToken. We don't try to
-- decode them client- or server-side; the APNs HTTP/2 client takes
-- them as opaque identifiers.

CREATE TABLE IF NOT EXISTS public.push_device_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_token    text NOT NULL,
  -- "development" or "production" — must match the aps-environment
  -- entitlement on the iOS bundle that produced the token. APNs is
  -- strict about routing dev tokens to the dev gateway.
  environment     text NOT NULL CHECK (environment IN ('development', 'production')),
  -- Optional model/OS info for support-side debugging.
  device_name     text,
  os_version      text,
  app_version     text,
  is_active       boolean NOT NULL DEFAULT true,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- One row per (user, token) — re-registering the same token updates
  -- last_seen_at rather than inserting a duplicate.
  UNIQUE (user_id, device_token)
);

CREATE INDEX IF NOT EXISTS idx_push_device_tokens_user
  ON public.push_device_tokens(user_id)
  WHERE is_active;

CREATE TRIGGER set_push_device_tokens_updated_at
  BEFORE UPDATE ON public.push_device_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.push_device_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own push tokens"
  ON public.push_device_tokens FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own push tokens"
  ON public.push_device_tokens FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own push tokens"
  ON public.push_device_tokens FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own push tokens"
  ON public.push_device_tokens FOR DELETE
  USING (auth.uid() = user_id);
