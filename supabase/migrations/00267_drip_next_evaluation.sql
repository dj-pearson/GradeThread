-- US-943: Autonomous drip orchestration tick — self-gating evaluation cursor.
--
-- The autonomous engine tick (POST /api/drip/tick) runs frequently (e.g.
-- hourly) and must stay cheap + idempotent: most active enrollments have nothing
-- due on any given run. `next_evaluation_at` lets the tick skip enrollments that
-- aren't due yet with a single indexed predicate, instead of re-walking every
-- enrollment's graph each run. After processing an enrollment the tick stamps the
-- projected time of its next unsent step here; a NULL value means "evaluate on
-- the next run" (freshly enrolled, or never evaluated). Catch-up after downtime
-- is automatic: a window that elapsed while the engine was down simply has
-- next_evaluation_at in the past, so the next run picks it up rather than
-- skipping it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index. Service-role only
-- (the table already has RLS on with no policy from 00253).

BEGIN;

ALTER TABLE public.drip_enrollments
  ADD COLUMN IF NOT EXISTS next_evaluation_at timestamptz;

COMMENT ON COLUMN public.drip_enrollments.next_evaluation_at IS
  'US-943: when the autonomous tick should next evaluate this enrollment. NULL = '
  'evaluate on the next run. The tick self-gates on this so frequent ticks stay cheap.';

-- Partial index over the exact predicate the tick filters on: active (not exited)
-- enrollments whose evaluation is due. Keeps the per-tick scan bounded to the
-- backlog regardless of total enrollment volume.
CREATE INDEX IF NOT EXISTS drip_enrollments_due_idx
  ON public.drip_enrollments (campaign, next_evaluation_at)
  WHERE exited_at IS NULL;

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00267')
ON CONFLICT (version) DO NOTHING;
