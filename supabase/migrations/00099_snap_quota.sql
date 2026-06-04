-- US-614: per-plan monthly Snap-to-Value quota.
--
-- Snap-to-Value (US-612) is free but signup-gated; a monthly cap keeps the free
-- viral funnel from becoming an unbounded AI-cost sink and gives free users a
-- reason to upgrade. Mirrors the ai_actions monthly-reset counter (00087) with a
-- dedicated snaps counter so snaps and AI actions don't share a budget.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS snaps_used_this_month int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snaps_reset_at timestamptz NOT NULL DEFAULT now();

-- Atomic, cap-aware reservation with monthly rollover (copy of reserve_ai_action).
-- p_limit = -1 means unlimited. Returns true iff a snap was reserved.
CREATE OR REPLACE FUNCTION public.reserve_snap(p_user_id uuid, p_limit int)
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
  SELECT snaps_used_this_month, snaps_reset_at
    INTO v_used, v_reset
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_rolled := date_trunc('month', v_reset) < date_trunc('month', now());
  IF v_rolled THEN
    v_used := 0;
  END IF;

  IF p_limit <> -1 AND v_used >= p_limit THEN
    UPDATE public.users
      SET snaps_used_this_month = v_used,
          snaps_reset_at = CASE WHEN v_rolled THEN now() ELSE snaps_reset_at END
      WHERE id = p_user_id;
    RETURN false;
  END IF;

  UPDATE public.users
    SET snaps_used_this_month = v_used + 1,
        snaps_reset_at = CASE WHEN v_rolled THEN now() ELSE snaps_reset_at END
    WHERE id = p_user_id;
  RETURN true;
END;
$$;

-- Give a reserved snap back when the grade ultimately failed.
CREATE OR REPLACE FUNCTION public.refund_snap(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.users
    SET snaps_used_this_month = greatest(0, snaps_used_this_month - 1)
    WHERE id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.reserve_snap(uuid, int) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_snap(uuid) FROM anon, authenticated;
