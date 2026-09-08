-- Cloud storage connections: one durable OAuth grant per user per provider, for
-- importing photos out of a folder the seller already keeps (US-3159, US-3160).
--
-- ONE TABLE, NOT ONE PER PROVIDER. google_photos_connections (00491) and
-- google_connections each exist because their grants differ in scope and in
-- lifetime. Dropbox and OneDrive do not differ from each other in either: both
-- are a refresh token plus a short-lived access token, both read a folder, and
-- both are reached through the same import route. A `provider` column keeps the
-- third and fourth providers from being two more copies of this file.
--
-- Google Drive is deliberately NOT in the check constraint. Its grant needs the
-- browser-side Picker and a scope of its own; see the note on US-3158. Adding it
-- later is an ALTER on the constraint, which is the small cost of being honest
-- now rather than leaving a value nothing writes.
--
-- Same security posture as google_connections and marketplace_connections: both
-- token columns are ciphertext (AES-256-GCM, AAD = user_id, useless without the
-- server key), the service-role edge client is the only writer, and the owner
-- may READ its own row so the SPA can render connection status.

CREATE TABLE IF NOT EXISTS public.cloud_storage_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider            text NOT NULL,
  account_label       text,                       -- e.g. the account's email
  refresh_token_enc   text,                       -- AES-GCM (AAD = user_id)
  access_token_enc    text,                       -- AES-GCM (AAD = user_id)
  token_expires_at    timestamptz,
  scope               text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Named so it can be dropped and re-added when a provider is added. An unnamed
-- inline CHECK gets a generated name that differs between environments.
ALTER TABLE public.cloud_storage_connections
  DROP CONSTRAINT IF EXISTS cloud_storage_connections_provider_check;
ALTER TABLE public.cloud_storage_connections
  ADD CONSTRAINT cloud_storage_connections_provider_check
  CHECK (provider IN ('dropbox', 'onedrive'));

-- One grant per user per provider — reconnect upserts the same row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_storage_connections_user_provider
  ON public.cloud_storage_connections(user_id, provider);

ALTER TABLE public.cloud_storage_connections ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner so the SPA can render connection status. Every write
-- goes through the service-role edge client (no INSERT/UPDATE/DELETE policy).
DROP POLICY IF EXISTS "Users read own cloud storage connections" ON public.cloud_storage_connections;
CREATE POLICY "Users read own cloud storage connections"
  ON public.cloud_storage_connections
  FOR SELECT
  USING ((select auth.uid()) = user_id);

-- Single-use state rows for the OAuth round trip. The provider redirects the
-- browser back UNAUTHENTICATED, so the state is the only thing that says which
-- user started the flow; it is deleted the moment it is spent.
CREATE TABLE IF NOT EXISTS public.cloud_storage_oauth_states (
  state         text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  code_verifier text,                             -- PKCE, for providers that need it
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_storage_oauth_states_expires
  ON public.cloud_storage_oauth_states(expires_at);

ALTER TABLE public.cloud_storage_oauth_states ENABLE ROW LEVEL SECURITY;
-- No policy at all: nothing but the service-role client ever reads a state row,
-- and the row is spent within minutes of being written.

DROP TRIGGER IF EXISTS set_cloud_storage_connections_updated_at ON public.cloud_storage_connections;
CREATE TRIGGER set_cloud_storage_connections_updated_at
  BEFORE UPDATE ON public.cloud_storage_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00766') on conflict do nothing;
