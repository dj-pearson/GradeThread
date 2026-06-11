-- Google Sheets connection (US-146). A long-lived OAuth grant that lets
-- FlipDesk read and write a single designated "FlipDesk Sync" spreadsheet on
-- the user's Drive. Kept in its OWN table rather than overloading
-- marketplace_connections: Google is a sync target, not a sales marketplace,
-- and it carries Sheets-specific state (sheet_id, sheet_url, sync_status).
--
-- Scopes requested: drive.file (per-file — only files the app creates or the
-- user explicitly opens via the Picker) + spreadsheets. No full-Drive access.
--
-- Tokens are stored ENCRYPTED (AES-256-GCM, AAD = user_id) exactly like the
-- eBay grant in marketplace_connections; the edge service holds the key and is
-- the only writer (service-role). The SPA may READ its own row (RLS below) to
-- render the connection status — the token columns are ciphertext and useless
-- without the server key, same posture as marketplace_connections.

CREATE TABLE IF NOT EXISTS public.google_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  google_email        text,
  access_token_enc    text,                          -- AES-GCM (AAD = user_id)
  refresh_token_enc   text,                          -- AES-GCM (AAD = user_id)
  token_expires_at    timestamptz,
  sheet_id            text,                          -- the FlipDesk Sync spreadsheet
  sheet_url           text,
  last_sync_at        timestamptz,
  -- idle | syncing | error | never
  sync_status         text NOT NULL DEFAULT 'never',
  sync_error          text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One Google grant per user — reconnect upserts the same row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_google_connections_user
  ON public.google_connections(user_id);

ALTER TABLE public.google_connections ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner so the SPA can render connection status. All writes
-- go through the service-role edge client (no INSERT/UPDATE/DELETE policy).
DROP POLICY IF EXISTS "Users read own google connection" ON public.google_connections;
CREATE POLICY "Users read own google connection"
  ON public.google_connections
  FOR SELECT
  USING (auth.uid() = user_id);

-- Keep updated_at fresh on every write (mirrors every other table's trigger).
DROP TRIGGER IF EXISTS set_google_connections_updated_at ON public.google_connections;
CREATE TRIGGER set_google_connections_updated_at
  BEFORE UPDATE ON public.google_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Single-use OAuth CSRF state for the Google consent dance. Can't reuse
-- oauth_states (its `marketplace` column is the listing_platform enum, and
-- Google isn't a listing platform). Same posture as oauth_states: service-role
-- only, self-expiring, deleted on first use so a code can't be replayed.
CREATE TABLE IF NOT EXISTS public.google_oauth_states (
  state        text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  redirect_to  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_google_oauth_states_expires
  ON public.google_oauth_states(expires_at);

ALTER TABLE public.google_oauth_states ENABLE ROW LEVEL SECURITY;
-- No policies → all access via the service-role edge client only.
