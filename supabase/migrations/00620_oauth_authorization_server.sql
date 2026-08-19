-- US-9122: storage for the connector's OAuth 2.1 authorization server.
--
-- Five tables, one per lifetime: a registered client, a short-lived
-- authorization code, a long-lived grant, its rotating refresh tokens, and the
-- short-lived access tokens those mint.
--
-- EVERY SECRET IS STORED HASHED. Codes and refresh tokens are held as a
-- hex SHA-256 (HMAC-with-pepper when API_KEY_PEPPER is set), the same way
-- api_keys holds key_hash. A leaked table of hashes is not a leaked table of
-- credentials, and there is no path in the code that needs the plaintext back.
--
-- ALL DENY-ALL. No policies at all: readable, these tables are a map of which
-- sellers connected what and when, plus the material to impersonate them;
-- writable, a caller could mint their own grant. Registered in
-- SERVICE_ROLE_ONLY in rls-guard_test.ts. Owner columns are named
-- `owner_user_id` per the rls-guard discovery convention.
--
-- NO REVOKE ANYWHERE IN THIS FILE. On this Postgres image a denied call from a
-- role in supautils.hint_roles segfaults the backend and restarts the database
-- (US-2403, which is why 00527 is permanently blocked). The sweep function
-- below guards in its body instead, as 00615, 00617 and 00619 do.

-- ── Clients ─────────────────────────────────────────────────────────
--
-- client_id is TEXT, not a uuid, because the mechanism the MCP authorization
-- spec now prefers is Client ID Metadata Documents: the client_id IS an https
-- URL the authorization server fetches metadata from. Dynamic registration
-- (RFC 7591) is deprecated and produces an opaque id instead, so the column has
-- to hold both.
CREATE TABLE IF NOT EXISTS public.oauth_clients (
  client_id          text PRIMARY KEY,
  client_name        text,
  -- NULL for a public client. Present ones are hashed like every other secret.
  client_secret_hash text,
  redirect_uris      text[] NOT NULL DEFAULT '{}',
  grant_types        text[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
  -- 'metadata_document' (preferred), 'dynamic' (deprecated RFC 7591) or
  -- 'preregistered'. Recorded so an audit can tell how a client got here.
  registration_source text NOT NULL DEFAULT 'dynamic',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ── Grants ──────────────────────────────────────────────────────────
--
-- One row per (seller, client) authorization. Revoking this kills every token
-- descended from it, which is what makes refresh-reuse detection meaningful.
CREATE TABLE IF NOT EXISTS public.oauth_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id     text NOT NULL REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE,
  scopes        text[] NOT NULL DEFAULT '{}',
  -- RFC 8707: what tokens from this grant are FOR. Checked on every request.
  resource      text NOT NULL,
  revoked_at    timestamptz,
  -- Why it was revoked: 'user', 'reuse_detected', 'code_replayed', 'admin'.
  -- An investigation wants to tell a seller's own disconnect apart from a
  -- token that turned up twice.
  revoked_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_grants_owner
  ON public.oauth_grants (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_client
  ON public.oauth_grants (client_id);

-- ── Authorization codes ─────────────────────────────────────────────
--
-- Single use and short-lived (60s). `consumed_at` is what makes a replay
-- VISIBLE rather than silent, and `grant_id` is what a replay has to revoke —
-- detecting the replay while leaving the grant alive is not a defence.
CREATE TABLE IF NOT EXISTS public.oauth_authorization_codes (
  code_hash             text PRIMARY KEY,
  owner_user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id             text NOT NULL REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  scopes                text[] NOT NULL DEFAULT '{}',
  resource              text NOT NULL,
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  grant_id              uuid REFERENCES public.oauth_grants(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires
  ON public.oauth_authorization_codes (expires_at);

-- ── Refresh tokens ──────────────────────────────────────────────────
--
-- Rotating: only the newest generation in a grant is live. `rotated_at` on an
-- older row is what turns a second presentation into reuse detection.
CREATE TABLE IF NOT EXISTS public.oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  grant_id   uuid NOT NULL REFERENCES public.oauth_grants(id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_grant
  ON public.oauth_refresh_tokens (grant_id, generation DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires
  ON public.oauth_refresh_tokens (expires_at);

-- ── Access tokens ───────────────────────────────────────────────────
--
-- Opaque and STORED, not signed and stateless. A signed token would save this
-- table and save nothing else: every request has to load the grant anyway, to
-- learn the tenant and the scopes and to check the grant is not revoked. So the
-- stateless version buys no read, costs a signing-key rotation story, and makes
-- "revoke this now" mean "revoke this within the token lifetime".
--
-- Short-lived (1 hour). Revoking the grant kills these immediately because the
-- request path checks the grant, not just the token.
CREATE TABLE IF NOT EXISTS public.oauth_access_tokens (
  token_hash text PRIMARY KEY,
  grant_id   uuid NOT NULL REFERENCES public.oauth_grants(id) ON DELETE CASCADE,
  scopes     text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_access_grant
  ON public.oauth_access_tokens (grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_expires
  ON public.oauth_access_tokens (expires_at);

ALTER TABLE public.oauth_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
-- No policies on any of the five: deny-all for anon and authenticated. A seller
-- sees and revokes their connected clients through an authenticated endpoint
-- that filters for them, never by reading these tables.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_codes_challenge_method_check'
      AND conrelid = 'public.oauth_authorization_codes'::regclass
  ) THEN
    -- S256 only. `plain` makes PKCE decorative and OAuth 2.1 removed it; the
    -- published metadata advertises S256 alone, so a row claiming otherwise
    -- would be storage disagreeing with what we told clients.
    ALTER TABLE public.oauth_authorization_codes
      ADD CONSTRAINT oauth_codes_challenge_method_check
      CHECK (code_challenge_method = 'S256');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_clients_registration_source_check'
      AND conrelid = 'public.oauth_clients'::regclass
  ) THEN
    ALTER TABLE public.oauth_clients
      ADD CONSTRAINT oauth_clients_registration_source_check
      CHECK (registration_source IN ('metadata_document', 'dynamic', 'preregistered'));
  END IF;
END $$;

-- Expired codes and refresh tokens are dead weight and, until swept, a longer
-- window in which a leaked backup is useful. Called by the maintenance cron.
--
-- GUARDED IN THE BODY, NOT BY A REVOKE — see the header.
CREATE OR REPLACE FUNCTION public.sweep_oauth_expired()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_codes integer;
  v_tokens integer;
  v_access integer;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'sweep_oauth_expired: service role required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.oauth_authorization_codes WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS v_codes = ROW_COUNT;

  DELETE FROM public.oauth_refresh_tokens WHERE expires_at < now() - interval '30 days';
  GET DIAGNOSTICS v_tokens = ROW_COUNT;

  -- Kept a day past expiry so a support question about a request from this
  -- morning still has a row to point at.
  DELETE FROM public.oauth_access_tokens WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS v_access = ROW_COUNT;

  RETURN v_codes + v_tokens + v_access;
END;
$$;

-- Self-record (US-1108) so the edge boot guard stays truthful however this ran.
insert into public.applied_migrations (version) values ('00620') on conflict do nothing;
