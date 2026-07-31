-- 00507 — AutoLister phone → desktop handoff sessions (US-2374)
--
-- The desktop AutoLister keeps its working session (staged photos + groups) in
-- the BROWSER — IndexedDB, with localStorage as the fallback. That is fine for
-- one machine and useless across two: a batch shot and grouped on the phone has
-- nowhere to land except the phone's own memory, so the seller has to finish
-- the whole job on a 6-inch screen or start over on the desktop.
--
-- This is the shared shelf. The phone uploads its photos to the SAME staging
-- folder the desktop uploader uses (`{owner}/_staging/{staging_session_id}/…`,
-- POST /api/flipdesk/autolister/staging/upload) and writes one row here holding
-- the photo list and the grouping. The desktop lists open rows, loads one into
-- its own session state, and claims it. No AI runs and no inventory rows are
-- created — this is strictly the pre-generation review state.
--
-- `photos` / `groups` are the client's own shapes (StagedPhoto[] / Group[]),
-- stored verbatim so the desktop can rehydrate without a translation layer that
-- would have to be kept in lockstep with the page. The edge validates the parts
-- that matter for safety (every storage path lives under the caller's own
-- `_staging/` prefix) and caps the size.

CREATE TABLE IF NOT EXISTS public.autolister_handoff_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The `_staging/{…}` folder segment the photos were uploaded under.
  staging_session_id  text NOT NULL,
  -- Which client sent it, so the desktop can say "from your iPhone".
  source              text NOT NULL DEFAULT 'ios'
                        CHECK (source IN ('ios', 'android', 'web')),
  -- open = waiting on a desktop; claimed = loaded there (kept briefly so a
  -- mis-click can be recovered rather than silently losing an upload).
  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'claimed')),
  photo_count         integer NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  group_count         integer NOT NULL DEFAULT 0 CHECK (group_count >= 0),
  photos              jsonb NOT NULL DEFAULT '[]'::jsonb,
  groups              jsonb NOT NULL DEFAULT '[]'::jsonb,
  claimed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The read path: "what is waiting for me", newest first.
CREATE INDEX IF NOT EXISTS autolister_handoff_sessions_open_idx
  ON public.autolister_handoff_sessions (user_id, created_at DESC)
  WHERE status = 'open';

ALTER TABLE public.autolister_handoff_sessions ENABLE ROW LEVEL SECURITY;

-- Owner-readable so the SPA can poll for waiting handoffs with the plain
-- client (the same read-direct / write-through-edge split the rest of FlipDesk
-- uses). Every write goes through the service-role edge client, which enforces
-- the staging-path ownership check — hence no INSERT/UPDATE policy here.
DROP POLICY IF EXISTS "Users read own autolister handoffs" ON public.autolister_handoff_sessions;
CREATE POLICY "Users read own autolister handoffs"
  ON public.autolister_handoff_sessions
  FOR SELECT
  USING ((select auth.uid()) = user_id);

-- Discarding one is the owner's own call and needs no server logic beyond the
-- storage sweep the edge does alongside it.
DROP POLICY IF EXISTS "Users delete own autolister handoffs" ON public.autolister_handoff_sessions;
CREATE POLICY "Users delete own autolister handoffs"
  ON public.autolister_handoff_sessions
  FOR DELETE
  USING ((select auth.uid()) = user_id);

-- Keep updated_at fresh on every write (mirrors every other table's trigger).
DROP TRIGGER IF EXISTS set_autolister_handoff_sessions_updated_at ON public.autolister_handoff_sessions;
CREATE TRIGGER set_autolister_handoff_sessions_updated_at
  BEFORE UPDATE ON public.autolister_handoff_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00507') on conflict do nothing;
