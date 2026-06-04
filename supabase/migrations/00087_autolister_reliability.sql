-- US-525/526/527: AutoLister generation reliability.
--
-- 1. use_comps on the batch so the reclaimer (US-525) can RESUME a stalled
--    batch with the same comp-pricing setting the user chose.
-- 2. reserve_ai_action(): atomic, cap-aware AI-action reservation (US-527).
--    The old flow checked the monthly quota once at enqueue and then gated the
--    run with an in-memory counter, so two parallel batches each saw the same
--    "remaining" and could collectively blow past the cap. This RPC makes the
--    increment atomic under a row lock and refuses when the cap is reached, so
--    it is the single enforcement point regardless of how many batches run.
-- 3. refund_ai_action(): give a reserved slot back when generation fails, so a
--    failed item doesn't permanently consume quota.
-- 4. A partial index to cheaply find stalled 'running' batches for the sweeper.

ALTER TABLE public.listing_generation_batches
  ADD COLUMN IF NOT EXISTS use_comps boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.listing_generation_batches.use_comps IS
  'US-525: comp-pricing setting captured at enqueue so the reclaim sweeper can resume a stalled batch with the same option.';

-- Atomically reserve one AI action against the monthly cap. Mirrors the month
-- rollover logic of increment_ai_actions (00024). Returns true if reserved,
-- false if the cap is already reached. p_limit = -1 means unlimited.
CREATE OR REPLACE FUNCTION public.reserve_ai_action(p_user_id uuid, p_limit int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used  int;
  v_reset timestamptz;
  v_rolled boolean;
BEGIN
  SELECT ai_actions_used_this_month, ai_actions_reset_at
    INTO v_used, v_reset
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Month rollover: if the counter is from a prior month, it's effectively 0.
  v_rolled := date_trunc('month', v_reset) < date_trunc('month', now());
  IF v_rolled THEN
    v_used := 0;
  END IF;

  -- Cap check (-1 = unlimited). Persist any rollover even on refusal so the
  -- stored counter stays correct.
  IF p_limit <> -1 AND v_used >= p_limit THEN
    UPDATE public.users
      SET ai_actions_used_this_month = v_used,
          ai_actions_reset_at = CASE WHEN v_rolled THEN now() ELSE ai_actions_reset_at END
      WHERE id = p_user_id;
    RETURN false;
  END IF;

  UPDATE public.users
    SET ai_actions_used_this_month = v_used + 1,
        ai_actions_reset_at = CASE WHEN v_rolled THEN now() ELSE ai_actions_reset_at END
    WHERE id = p_user_id;
  RETURN true;
END;
$$;

-- Give a reserved AI action back (clamped at 0) when the generation it was
-- reserved for ultimately fails.
CREATE OR REPLACE FUNCTION public.refund_ai_action(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.users
    SET ai_actions_used_this_month = greatest(0, ai_actions_used_this_month - 1)
    WHERE id = p_user_id;
$$;

-- The reclaim sweeper scans for 'running' batches whose updated_at (bumped on
-- every progress roll-up) has gone stale — i.e. the worker died.
CREATE INDEX IF NOT EXISTS idx_listing_generation_batches_running_updated
  ON public.listing_generation_batches (updated_at)
  WHERE status = 'running';
