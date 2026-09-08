-- Phone-as-camera capture sessions (US-3161).
--
-- A seller at a desktop scans a code and their phone becomes the camera for one
-- item. The phone is NOT signed in — that is the whole point, because the fast
-- version of this has no app install and no password typed on a phone keyboard
-- while holding a jumper. So the scanned token is the only credential, and
-- every limit on what it can do has to live here rather than in a session.
--
-- WHAT THE TOKEN CAN DO, deliberately narrow:
--   • ONE target. A session is bound to one inventory item or one AutoLister
--     batch at creation and cannot be repointed.
--   • For a SHORT time. Fifteen minutes or less, set at creation.
--   • A BOUNDED amount. Photo count and total bytes are counted here, so the
--     caps are enforced server-side and not by a page that can be edited.
--   • Until it is finished. Ending it from the desktop is permanent.
--
-- THE TOKEN IS STORED AS A HASH, NEVER AS ITSELF. It is a bearer credential:
-- anyone holding it can add photos to the seller's item for as long as it
-- lives. Storing it in plaintext would mean a database read is an upload
-- credential; storing sha-256 means the row is worth nothing on its own, and
-- lookup by hash costs the same as lookup by value.
--
-- Deliberately NOT derived from the target id. A token computed from an item id
-- would be forgeable by anyone who ever saw that id — including the seller's own
-- pages — which is exactly the mistake this note exists to prevent.

CREATE TABLE IF NOT EXISTS public.phone_capture_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha-256 of the scanned token, hex. Unique so a collision cannot silently
  -- point two sessions at one code.
  token_hash          text NOT NULL,
  -- Whose storage folder the photos land in (the workspace owner). The staging
  -- path is built from this, so it is what the per-user-folder RLS reads.
  owner_user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The person who pressed the button. Kept apart from the owner because a
  -- workspace member may start a capture for a workspace they do not own.
  started_by_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_kind         text NOT NULL,
  target_id           uuid NOT NULL,
  expires_at          timestamptz NOT NULL,
  ended_at            timestamptz,
  photo_count         integer NOT NULL DEFAULT 0,
  bytes_total         bigint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_phone_capture_sessions_token
  ON public.phone_capture_sessions(token_hash);

-- The desktop lists its own live sessions; the sweep reads expiry.
CREATE INDEX IF NOT EXISTS idx_phone_capture_sessions_owner
  ON public.phone_capture_sessions(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_capture_sessions_expires
  ON public.phone_capture_sessions(expires_at);

ALTER TABLE public.phone_capture_sessions
  DROP CONSTRAINT IF EXISTS phone_capture_sessions_target_kind_check;
ALTER TABLE public.phone_capture_sessions
  ADD CONSTRAINT phone_capture_sessions_target_kind_check
  CHECK (target_kind IN ('item', 'batch'));

ALTER TABLE public.phone_capture_sessions ENABLE ROW LEVEL SECURITY;
-- No policy at all, in either direction. A readable row would hand a signed-in
-- caller the shape of every live capture in the workspace; a writable one would
-- let them raise their own caps or move their own expiry. The desktop reads
-- status through an authenticated edge route that scopes by owner, and the
-- phone reads its own session by presenting the token. Registered in
-- SERVICE_ROLE_ONLY in rls-guard_test.ts.

-- One row per photo the phone sent, so the desktop can show them arriving and
-- so a retry cannot double-count against the session's caps.
CREATE TABLE IF NOT EXISTS public.phone_capture_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES public.phone_capture_sessions(id) ON DELETE CASCADE,
  storage_path  text NOT NULL,
  public_url    text NOT NULL,
  width         integer,
  height        integer,
  bytes         integer NOT NULL DEFAULT 0,
  -- The phone's own id for the shot. Unique per session, so a retry of an
  -- upload that actually landed replaces nothing and adds nothing.
  client_key    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_phone_capture_photos_client_key
  ON public.phone_capture_photos(session_id, client_key)
  WHERE client_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_phone_capture_photos_session
  ON public.phone_capture_photos(session_id, created_at);

ALTER TABLE public.phone_capture_photos ENABLE ROW LEVEL SECURITY;
-- Same reasoning as the parent: no policy, service-role only. It has no owner
-- column of its own — tenancy flows through session_id — and both readers are
-- edge routes that resolve the session first.

DROP TRIGGER IF EXISTS set_phone_capture_sessions_updated_at ON public.phone_capture_sessions;
CREATE TRIGGER set_phone_capture_sessions_updated_at
  BEFORE UPDATE ON public.phone_capture_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00767') on conflict do nothing;
