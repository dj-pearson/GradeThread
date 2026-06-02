-- Photo Dump Reconciliation (RC-001 / US-279)
--
-- The reconciliation surface lets a reseller drop a single unsorted dump of
-- phone photos and have FlipDesk auto-split them into proposed items by capture
-- time. To make that clustering survive a page reload we persist (a) the
-- original EXIF capture time per photo and (b) which reconcile session a photo
-- belongs to. Both columns are NULLable so every existing item_photos row is
-- unaffected by this migration.

-- Per-photo original capture timestamp (read from EXIF in the browser before
-- the upload pipeline re-encodes and strips it — see src/lib/exif.ts, US-280).
ALTER TABLE public.item_photos
  ADD COLUMN IF NOT EXISTS captured_at timestamptz;

-- Which reconcile session this photo was ingested through (NULL for the normal
-- per-item upload path). FK is set after the sessions table exists below.
ALTER TABLE public.item_photos
  ADD COLUMN IF NOT EXISTS reconcile_session_id uuid;

-- Session lifecycle: a dump is "open" while the user is clustering, becomes
-- "committed" once clusters are turned into inventory items, or "abandoned".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reconcile_session_status') THEN
    CREATE TYPE public.reconcile_session_status AS ENUM ('open', 'committed', 'abandoned');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.flipdesk_reconcile_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  photo_count integer NOT NULL DEFAULT 0,
  status      public.reconcile_session_status NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A user's sessions, freshest first.
CREATE INDEX IF NOT EXISTS idx_reconcile_sessions_user
  ON public.flipdesk_reconcile_sessions(user_id, created_at DESC);

-- Now that the table exists, link item_photos.reconcile_session_id to it.
-- SET NULL on delete so removing a session doesn't cascade-delete already
-- committed photos.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'item_photos_reconcile_session_id_fkey'
  ) THEN
    ALTER TABLE public.item_photos
      ADD CONSTRAINT item_photos_reconcile_session_id_fkey
      FOREIGN KEY (reconcile_session_id)
      REFERENCES public.flipdesk_reconcile_sessions(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_item_photos_reconcile_session
  ON public.item_photos(reconcile_session_id)
  WHERE reconcile_session_id IS NOT NULL;

CREATE TRIGGER set_reconcile_sessions_updated_at
  BEFORE UPDATE ON public.flipdesk_reconcile_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: owner-only on all four verbs, mirroring the item_photos / sources
-- per-user pattern. Writes from the edge service use the service-role client
-- and scope every query to the owner regardless (see US-268).
ALTER TABLE public.flipdesk_reconcile_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own reconcile sessions"
  ON public.flipdesk_reconcile_sessions FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Users can create own reconcile sessions"
  ON public.flipdesk_reconcile_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own reconcile sessions"
  ON public.flipdesk_reconcile_sessions FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own reconcile sessions"
  ON public.flipdesk_reconcile_sessions FOR DELETE
  USING (auth.uid() = user_id);
