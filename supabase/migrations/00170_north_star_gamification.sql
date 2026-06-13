-- US-597: Surface + gamify the "Items Listed Per Week" North Star.
--
-- The PRD North Star metric is Items-Listed-Per-Week — the throughput that
-- directly correlates with revenue and platform value. The in-app surface
-- (weekly goal + streak) is computed client-side from items_full, but the
-- weekly *encouragement / milestone emails* run from an unattended cron and
-- need two things this migration provides:
--
--   1. Aggregate helpers (RPC) so the cron can cheaply ask "how many items did
--      each user list last week?" and "what's each user's lifetime listed
--      count?" without pulling every listing row into the edge process.
--   2. Idempotency ledgers so a re-run (or an overlapping tick) never emails the
--      same weekly digest or milestone twice.
--
-- Counting rule mirrors the in-app surface and the overview page: an item is
-- "listed" when its listing has a non-null listed_at. Ownership flows
-- listings → inventory_items.user_id.

-- ─── Idempotency: weekly digest ledger ───────────────────────────────
-- One row per (user, ISO-Monday week) once that week's digest has been sent.
-- Also records the count we celebrated, so the digest can compute the streak
-- from prior weeks without recomputing from raw listings.
CREATE TABLE IF NOT EXISTS public.north_star_weekly_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Monday (date) that starts the celebrated week.
  week_start    date NOT NULL,
  items_listed  integer NOT NULL DEFAULT 0,
  -- Consecutive-week streak as of this week (computed by the cron).
  streak_weeks  integer NOT NULL DEFAULT 0,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_north_star_weekly_log_user
  ON public.north_star_weekly_log (user_id, week_start DESC);

COMMENT ON TABLE public.north_star_weekly_log IS
  'US-597: idempotency + history ledger for the weekly Items-Listed digest. '
  'One row per (user, Monday week); powers streak math and dedupes sends.';

-- ─── Idempotency: milestone ledger ───────────────────────────────────
-- One row per (user, lifetime milestone) once the celebration email has fired.
CREATE TABLE IF NOT EXISTS public.north_star_milestone_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  milestone   integer NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, milestone)
);

CREATE INDEX IF NOT EXISTS idx_north_star_milestone_log_user
  ON public.north_star_milestone_log (user_id);

COMMENT ON TABLE public.north_star_milestone_log IS
  'US-597: records which lifetime items-listed milestones have been emailed, '
  'so a milestone is celebrated exactly once per user.';

-- ─── RLS ─────────────────────────────────────────────────────────────
-- Both ledgers are written by the service-role cron. Owners may READ their own
-- rows (a future "your milestones" view); no anon access, no client writes.
ALTER TABLE public.north_star_weekly_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.north_star_milestone_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.north_star_weekly_log FROM anon;
REVOKE ALL ON public.north_star_milestone_log FROM anon;

CREATE POLICY "Users read own weekly north-star log"
  ON public.north_star_weekly_log
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users read own north-star milestones"
  ON public.north_star_milestone_log
  FOR SELECT
  USING (auth.uid() = user_id);

-- ─── Aggregate helpers (RPC) ─────────────────────────────────────────
-- Items listed in [p_start, p_end) grouped by owner. SECURITY DEFINER so the
-- service-role cron gets a single grouped scan instead of N round-trips.
CREATE OR REPLACE FUNCTION public.north_star_weekly_counts(
  p_start timestamptz,
  p_end   timestamptz
)
RETURNS TABLE (user_id uuid, items_listed bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ii.user_id, COUNT(*)::bigint AS items_listed
  FROM public.listings l
  JOIN public.inventory_items ii ON ii.id = l.inventory_item_id
  WHERE l.listed_at >= p_start
    AND l.listed_at <  p_end
  GROUP BY ii.user_id;
$$;

-- Lifetime listed count for a specific set of users (the ones who listed last
-- week — the only users whose milestone status can have changed).
CREATE OR REPLACE FUNCTION public.north_star_lifetime_counts(
  p_user_ids uuid[]
)
RETURNS TABLE (user_id uuid, total bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ii.user_id, COUNT(*)::bigint AS total
  FROM public.listings l
  JOIN public.inventory_items ii ON ii.id = l.inventory_item_id
  WHERE ii.user_id = ANY(p_user_ids)
  GROUP BY ii.user_id;
$$;

-- Service-role only — the cron calls these; no client/anon execution.
REVOKE ALL ON FUNCTION public.north_star_weekly_counts(timestamptz, timestamptz) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.north_star_lifetime_counts(uuid[]) FROM anon, authenticated;

COMMENT ON FUNCTION public.north_star_weekly_counts(timestamptz, timestamptz) IS
  'US-597: items-listed-per-week, grouped by owning user, for the digest cron.';
COMMENT ON FUNCTION public.north_star_lifetime_counts(uuid[]) IS
  'US-597: lifetime items-listed count for the given users (milestone checks).';
