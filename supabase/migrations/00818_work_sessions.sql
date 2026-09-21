-- Worth My Time, R1 02/12 (US-3167): a work session, its tasks, and the timing
-- events that record when each one ran.
--
-- The rules live twice on purpose and the two are NOT redundant.
-- lib/work-sessions.ts refuses a bad move with a sentence a seller can read;
-- the indexes below refuse it under CONCURRENCY, which no application check
-- can do. Two tabs pressing Start both pass a check-then-write in JavaScript
-- and only one survives a unique index.
--
-- WHAT IS DELIBERATELY ABSENT (AC1): no photos, no buyer addresses, no garment
-- notes. A task references an item and snapshots the few facts the plan was
-- built on. The moment history becomes a second copy of the item it becomes a
-- second thing to erase, to leak, and to keep in step.
--
-- ERASURE (AC4): every table here hangs off public.users(id) ON DELETE CASCADE,
-- so the existing delete_account() RPC (00043) removes planner data with no
-- change to it. That function deletes the auth.users row and lets the schema
-- own the cascade, which is why this needs no enumeration there.

CREATE TABLE IF NOT EXISTS public.flipdesk_work_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  state             text NOT NULL DEFAULT 'planned',
  -- The inputs the plan was built from, snapshotted. A seller who changes
  -- their tools tomorrow must not silently rewrite yesterday's plan.
  work_context      text NOT NULL,
  available_tools   text[] NOT NULL DEFAULT '{}'::text[],
  budget_minutes    integer NOT NULL,
  planner_version   integer NOT NULL DEFAULT 1,
  -- Optimistic concurrency. Every progress write carries the revision it read
  -- and the update is scoped to it, so two tabs cannot silently overwrite each
  -- other (AC4).
  revision          integer NOT NULL DEFAULT 1,
  started_at        timestamptz,
  ended_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.flipdesk_work_sessions IS
  'US-3167 (Worth My Time R1 02/12): one block of time a seller sat down to work. Holds no item content -- see flipdesk_work_session_tasks.';
COMMENT ON COLUMN public.flipdesk_work_sessions.revision IS
  'US-3167: optimistic-concurrency token. A progress write is scoped to the revision it read, so two tabs cannot silently overwrite each other.';

ALTER TABLE public.flipdesk_work_sessions
  DROP CONSTRAINT IF EXISTS flipdesk_work_sessions_state_chk;
ALTER TABLE public.flipdesk_work_sessions
  ADD CONSTRAINT flipdesk_work_sessions_state_chk
  CHECK (state IN ('planned', 'active', 'paused', 'completed', 'abandoned'));

ALTER TABLE public.flipdesk_work_sessions
  DROP CONSTRAINT IF EXISTS flipdesk_work_sessions_budget_chk;
ALTER TABLE public.flipdesk_work_sessions
  ADD CONSTRAINT flipdesk_work_sessions_budget_chk
  CHECK (budget_minutes BETWEEN 5 AND 240);

ALTER TABLE public.flipdesk_work_sessions
  DROP CONSTRAINT IF EXISTS flipdesk_work_sessions_context_chk;
ALTER TABLE public.flipdesk_work_sessions
  ADD CONSTRAINT flipdesk_work_sessions_context_chk
  CHECK (work_context IN ('home', 'phone_only'));

-- ONE ACTIVE SESSION PER WORKSPACE, enforced by the database rather than by
-- the screen (AC2). A partial unique index is the only thing that holds under
-- two concurrent requests; a SELECT-then-INSERT in the route passes twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_sessions_one_active_per_user
  ON public.flipdesk_work_sessions (user_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_work_sessions_user_recent
  ON public.flipdesk_work_sessions (user_id, created_at DESC);

DROP TRIGGER IF EXISTS set_flipdesk_work_sessions_updated_at
  ON public.flipdesk_work_sessions;
CREATE TRIGGER set_flipdesk_work_sessions_updated_at
  BEFORE UPDATE ON public.flipdesk_work_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.flipdesk_work_session_tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           uuid NOT NULL REFERENCES public.flipdesk_work_sessions(id) ON DELETE CASCADE,
  -- Denormalized so every read and every policy can scope on the owner without
  -- a join. The service-role client bypasses RLS, so an owner column the query
  -- can name directly is the cheapest way to make US-268 scoping obvious.
  user_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- ON DELETE SET NULL, NOT CASCADE (AC4). A deleted garment must not erase
  -- the seller's record of the hour they spent on it; the null is what
  -- isActionable() reads to stop handing them a task pointing at nothing.
  inventory_item_id    uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  item_title_snapshot  text,
  position             integer NOT NULL,
  state                text NOT NULL DEFAULT 'pending',
  action_key           text NOT NULL,
  prerequisite_keys    text[] NOT NULL DEFAULT '{}'::text[],
  bin_snapshot         text,
  estimate_minutes     integer,
  estimate_value_cents bigint,
  estimate_source      text,
  estimate_taken_at    timestamptz,
  -- Observed, confirmed and corrected are three different numbers and are
  -- stored as three (AC3). Observed is the clock. Confirmed is what the seller
  -- says they actually spent. A correction is a later edit. Collapsing them
  -- would make R2's learning train on time spent making tea.
  observed_minutes     integer,
  confirmed_minutes    integer,
  correction_minutes   integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, position)
);

COMMENT ON TABLE public.flipdesk_work_session_tasks IS
  'US-3167: one task inside a session. inventory_item_id is ON DELETE SET NULL so a deleted garment tombstones the task rather than erasing the seller''s record of the work.';
COMMENT ON COLUMN public.flipdesk_work_session_tasks.observed_minutes IS
  'US-3167: what the clock said. Distinct from confirmed_minutes (what the seller says) and correction_minutes (a later edit). Never collapse them.';

ALTER TABLE public.flipdesk_work_session_tasks
  DROP CONSTRAINT IF EXISTS flipdesk_work_session_tasks_state_chk;
ALTER TABLE public.flipdesk_work_session_tasks
  ADD CONSTRAINT flipdesk_work_session_tasks_state_chk
  CHECK (state IN ('pending', 'active', 'completed', 'skipped', 'invalidated'));

ALTER TABLE public.flipdesk_work_session_tasks
  DROP CONSTRAINT IF EXISTS flipdesk_work_session_tasks_minutes_chk;
ALTER TABLE public.flipdesk_work_session_tasks
  ADD CONSTRAINT flipdesk_work_session_tasks_minutes_chk
  CHECK (
    (observed_minutes   IS NULL OR observed_minutes   >= 0) AND
    (confirmed_minutes  IS NULL OR confirmed_minutes  >= 0) AND
    (correction_minutes IS NULL OR correction_minutes >= 0) AND
    (estimate_minutes   IS NULL OR estimate_minutes   >= 0) AND
    (estimate_value_cents IS NULL OR estimate_value_cents >= 0)
  );

-- AT MOST ONE ACTIVE TASK PER SESSION (AC2), same reasoning as above: this
-- holds under two concurrent Start presses and an application check does not.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_session_tasks_one_active
  ON public.flipdesk_work_session_tasks (session_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_work_session_tasks_session
  ON public.flipdesk_work_session_tasks (session_id, position);
CREATE INDEX IF NOT EXISTS idx_work_session_tasks_user
  ON public.flipdesk_work_session_tasks (user_id);

DROP TRIGGER IF EXISTS set_flipdesk_work_session_tasks_updated_at
  ON public.flipdesk_work_session_tasks;
CREATE TRIGGER set_flipdesk_work_session_tasks_updated_at
  BEFORE UPDATE ON public.flipdesk_work_session_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.flipdesk_work_timing_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES public.flipdesk_work_session_tasks(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  -- The retry key, derived from what the event IS rather than generated per
  -- attempt (AC3). A client minting a fresh uuid per try deduplicates nothing:
  -- the retry after a timeout carries a different key and lands twice.
  retry_key   text NOT NULL,
  -- SERVER time. A client clock is not evidence of when anything happened, and
  -- a skewed one would make a task look like it took negative minutes.
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, retry_key)
);

COMMENT ON TABLE public.flipdesk_work_timing_events IS
  'US-3167: append-only record of when a task started, paused and finished. UNIQUE (task_id, retry_key) is what makes a repeated request a no-op rather than double-counted time.';

ALTER TABLE public.flipdesk_work_timing_events
  DROP CONSTRAINT IF EXISTS flipdesk_work_timing_events_kind_chk;
ALTER TABLE public.flipdesk_work_timing_events
  ADD CONSTRAINT flipdesk_work_timing_events_kind_chk
  CHECK (kind IN ('task_started', 'task_paused', 'task_completed', 'session_paused', 'session_resumed'));

CREATE INDEX IF NOT EXISTS idx_work_timing_events_task
  ON public.flipdesk_work_timing_events (task_id, occurred_at);

-- RLS: owner-scoped SELECT on all three, and no write policy anywhere.
--
-- Reads and writes go through the authenticated edge routes, which resolve the
-- workspace owner. The SELECT policies are defence in depth for a direct
-- client read of a seller's own rows; writes are service-role only, because a
-- direct write would bypass the transition guards this whole story is about.
--
-- (select auth.uid()), not a bare auth.uid() (US-1927): the bare form is a
-- volatile call Postgres re-evaluates PER ROW, and these tables are read a
-- session at a time.
ALTER TABLE public.flipdesk_work_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own work sessions" ON public.flipdesk_work_sessions;
CREATE POLICY "Users can view own work sessions"
  ON public.flipdesk_work_sessions FOR SELECT
  USING ((select auth.uid()) = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.flipdesk_work_sessions FROM anon, authenticated;

ALTER TABLE public.flipdesk_work_session_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own work session tasks" ON public.flipdesk_work_session_tasks;
CREATE POLICY "Users can view own work session tasks"
  ON public.flipdesk_work_session_tasks FOR SELECT
  USING ((select auth.uid()) = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.flipdesk_work_session_tasks FROM anon, authenticated;

ALTER TABLE public.flipdesk_work_timing_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own work timing events" ON public.flipdesk_work_timing_events;
CREATE POLICY "Users can view own work timing events"
  ON public.flipdesk_work_timing_events FOR SELECT
  USING ((select auth.uid()) = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.flipdesk_work_timing_events FROM anon, authenticated;

insert into public.applied_migrations (version) values ('00818') on conflict do nothing;
