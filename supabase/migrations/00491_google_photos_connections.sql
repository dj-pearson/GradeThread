-- Google Photos connection (persistent grant for AutoLister imports).
--
-- Until now the Photos Picker import was per-import ONLY: online access, no
-- refresh token, the session row deleted after every import. That forced the
-- user through Google's full OAuth consent screen EVERY time they imported —
-- even twice within the same minute.
--
-- This adds a per-user persistent grant, mirroring google_connections (Sheets):
-- an ENCRYPTED refresh token (AES-256-GCM, AAD = user_id) that the edge reuses
-- to mint a fresh access token and open the Google picker DIRECTLY, skipping the
-- consent screen on every import after the first. The short-lived per-import
-- access token + picker session still live on google_photos_import_sessions
-- (migration 00089); only the durable refresh token lives here.
--
-- Same security posture as google_connections/marketplace_connections: the token
-- column is ciphertext (useless without the server key), the edge service-role
-- client is the only writer, and the owner may READ its own row (RLS below) to
-- render connection status.

CREATE TABLE IF NOT EXISTS public.google_photos_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  google_email       text,
  refresh_token_enc  text,                       -- AES-GCM (AAD = user_id)
  scope              text,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One Google Photos grant per user — reconnect upserts the same row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_google_photos_connections_user
  ON public.google_photos_connections(user_id);

ALTER TABLE public.google_photos_connections ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner so the SPA can render connection status. All writes go
-- through the service-role edge client (no INSERT/UPDATE/DELETE policy).
DROP POLICY IF EXISTS "Users read own google photos connection" ON public.google_photos_connections;
CREATE POLICY "Users read own google photos connection"
  ON public.google_photos_connections
  FOR SELECT
  USING ((select auth.uid()) = user_id);

-- Keep updated_at fresh on every write (mirrors every other table's trigger).
DROP TRIGGER IF EXISTS set_google_photos_connections_updated_at ON public.google_photos_connections;
CREATE TRIGGER set_google_photos_connections_updated_at
  BEFORE UPDATE ON public.google_photos_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00491') on conflict do nothing;
