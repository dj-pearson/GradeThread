-- One OPEN work session per seller, not one active one (US-3177).
--
-- 00818 created `uq_work_sessions_one_active_per_user` with the predicate
-- `state = 'active'`. A session is CREATED in state `planned` and only becomes
-- `active` when its first task starts, so the rule did not bind at the moment
-- it was needed -- at creation. `paused` was uncovered for the same reason.
--
-- WHAT THAT COST, measured end to end rather than reasoned about: a seller
-- could pause a session, build a second plan, and have the first drop off the
-- screen while staying open in the database. GET /sessions/current reads the
-- newest of planned/active/paused and returns one row, so the paused evening
-- became unreachable through the UI with no error anywhere. The route guard
-- (flipdesk-planner.ts) now reads the same three states; this is the half that
-- holds under two concurrent requests, which no application check can do.
--
-- THE BACKFILL IS NOT OPTIONAL AND IT IS WHY THIS FILE IS NOT THREE LINES.
-- The rows the bug produced are exactly the rows the new index refuses, so a
-- bare CREATE UNIQUE INDEX fails on any database where a seller made two
-- plans. It failed on the first machine it was tried on, which is how this
-- was found rather than shipped.
--
-- WHICH ONE SURVIVES: the one with completed work, and only then the newest.
-- The newest alone would have been easier and would have thrown away the
-- paused evening this migration exists to protect -- the orphaned session is
-- the OLD one, and it is the one with the work in it. Nothing is deleted
-- either way: `abandoned` is terminal, the tasks and timing events stay, and
-- the seller's record of the hour they spent is still theirs. What changes is
-- only which session GET /sessions/current can reach.

DO $$
DECLARE
  closed integer;
BEGIN
  WITH ranked AS (
    SELECT
      s.id,
      row_number() OVER (
        PARTITION BY s.user_id
        ORDER BY
          -- Work first. A session somebody finished tasks in outranks an
          -- empty plan made five minutes ago.
          (SELECT count(*) FROM public.flipdesk_work_session_tasks t
            WHERE t.session_id = s.id AND t.state = 'completed') DESC,
          s.created_at DESC,
          s.id
      ) AS rn
    FROM public.flipdesk_work_sessions s
    WHERE s.state IN ('planned', 'active', 'paused')
  )
  UPDATE public.flipdesk_work_sessions s
     SET state = 'abandoned',
         ended_at = COALESCE(s.ended_at, now())
    FROM ranked r
   WHERE s.id = r.id
     AND r.rn > 1;
  GET DIAGNOSTICS closed = ROW_COUNT;
  IF closed > 0 THEN
    RAISE NOTICE 'closed % duplicate open work session(s)', closed;
  END IF;
END $$;

-- The old index is dropped rather than left beside this one. Two overlapping
-- uniqueness rules on the same column would both fire on the same insert, and
-- the narrower one is entirely contained in the wider one.
DROP INDEX IF EXISTS public.uq_work_sessions_one_active_per_user;

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_sessions_one_open_per_user
  ON public.flipdesk_work_sessions (user_id)
  WHERE (state IN ('planned', 'active', 'paused'));

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00819') on conflict do nothing;
