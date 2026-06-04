-- Google Photos import (Picker API). A short-lived, server-only session that
-- ties together the per-import OAuth dance and the Google-hosted picker:
--   start  -> create a row + OAuth state, send the user to Google consent
--   callback -> exchange the code, create a Picker session, send the user to
--               the Google-hosted picker (stores the short-lived access token
--               ENCRYPTED so the import step can download the picked photos)
--   poll   -> ask Google whether the user has finished picking
--   import -> download the picked photos server-side, validate + strip EXIF,
--             stage them into item-photos, then the row is consumed.
--
-- No long-lived Google token is ever stored (access_type=online, ~1h token);
-- the row self-expires in 30 min. RLS: service-role only — the SPA never reads
-- this table; it drives the flow purely through the edge endpoints (which hold
-- the token). Same posture as oauth_states (00030).

CREATE TABLE IF NOT EXISTS public.google_photos_import_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Owner the imported photos are staged under (workspace owner for members).
  owner_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  state             text NOT NULL UNIQUE,            -- OAuth CSRF state
  -- pending | picking | ready | imported | error
  status            text NOT NULL DEFAULT 'pending',
  access_token_enc  text,                            -- AES-GCM encrypted (AAD = session id)
  token_expires_at  timestamptz,
  picker_session_id text,                            -- Google Picker session id
  picker_uri        text,                            -- Google-hosted picker URL
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '30 minutes')
);

CREATE INDEX IF NOT EXISTS idx_gphotos_sessions_user
  ON public.google_photos_import_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_gphotos_sessions_state
  ON public.google_photos_import_sessions(state);
CREATE INDEX IF NOT EXISTS idx_gphotos_sessions_expires
  ON public.google_photos_import_sessions(expires_at);

ALTER TABLE public.google_photos_import_sessions ENABLE ROW LEVEL SECURITY;
-- No policies → all access via the service-role edge client only.
