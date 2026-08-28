-- US-2972: give every existing item owner a user_reward_state row.
--
-- The nightly pipeline sweep uses user_reward_state.last_pipeline_sweep_at as
-- its work queue: oldest-swept-first, nulls first. That is a self-balancing
-- queue with guaranteed coverage and no cursor to keep, but it can only reach
-- sellers who HAVE a row, and a row was previously created only on a user's
-- first rewardable act. Every seller this feature exists for -- the ones who
-- listed for months and earned nothing -- is exactly a seller with no row.
--
-- So seed one for every distinct inventory_items owner. All-zero rows, which is
-- the state they are already in; the sweep is what puts real numbers in them.
--
-- Idempotent by ON CONFLICT, and re-runnable: a second run inserts nothing.
-- Ongoing coverage does not depend on re-running this. markSweepAttempted
-- upserts, so any seller who appears later gets a row the first time they are
-- swept on demand.
INSERT INTO public.user_reward_state (user_id)
SELECT DISTINCT i.user_id
FROM public.inventory_items i
ON CONFLICT (user_id) DO NOTHING;

-- Queue read: "oldest swept first, never-swept first". A partial index is wrong
-- here (the null half IS the hot half early on), so this is a plain index with
-- NULLS FIRST matching the query's ORDER BY.
CREATE INDEX IF NOT EXISTS idx_user_reward_state_sweep_queue
  ON public.user_reward_state(last_pipeline_sweep_at NULLS FIRST);

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00680') ON CONFLICT DO NOTHING;
