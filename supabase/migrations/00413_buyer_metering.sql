-- US-1800: buyer metered-action counters.
--
-- Buyer plans include monthly allowances for a few metered actions (extension
-- checks, authenticity credits, video-grade credits — buyer-plans.ts
-- BuyerAllowances). This is the atomic, cap-aware reserve/refund primitive the
-- buyer feature epics (US-1833/1840/1841) call, mirroring reserve_ai_action
-- (00087) but keyed per-meter. Usage lives in its OWN table (service-role only
-- writes) so it never touches the users self-update guard.

CREATE TABLE IF NOT EXISTS public.buyer_meter_usage (
  user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  -- { "extension_checks": 3, "authenticity_credits": 1, ... } for the period.
  usage       jsonb NOT NULL DEFAULT '{}'::jsonb,
  reset_at    timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.buyer_meter_usage ENABLE ROW LEVEL SECURITY;

-- Owner may READ their own usage (for the buyer billing usage meters). Writes
-- happen ONLY via the SECURITY DEFINER RPCs below (service role) — there is no
-- user INSERT/UPDATE policy, so a buyer can't reset their own counter.
DROP POLICY IF EXISTS "Users read own buyer meter usage" ON public.buyer_meter_usage;
CREATE POLICY "Users read own buyer meter usage"
  ON public.buyer_meter_usage FOR SELECT USING (auth.uid() = user_id);

-- Atomically reserve one unit of a buyer meter against the monthly cap
-- (p_limit = -1 = unlimited). Monthly rollover mirrors reserve_ai_action.
-- Returns true when reserved, false at the cap.
CREATE OR REPLACE FUNCTION public.reserve_buyer_meter(p_user_id uuid, p_meter text, p_limit int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usage  jsonb;
  v_reset  timestamptz;
  v_used   int;
  v_rolled boolean;
BEGIN
  INSERT INTO public.buyer_meter_usage(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

  SELECT usage, reset_at INTO v_usage, v_reset
    FROM public.buyer_meter_usage WHERE user_id = p_user_id FOR UPDATE;

  -- Month rollover: a counter from a prior month is effectively empty.
  v_rolled := v_reset IS NULL OR date_trunc('month', v_reset) < date_trunc('month', now());
  IF v_rolled THEN
    v_usage := '{}'::jsonb;
  END IF;

  v_used := COALESCE((v_usage ->> p_meter)::int, 0);

  IF p_limit <> -1 AND v_used >= p_limit THEN
    UPDATE public.buyer_meter_usage
      SET usage = v_usage,
          reset_at = CASE WHEN v_rolled THEN now() ELSE reset_at END,
          updated_at = now()
      WHERE user_id = p_user_id;
    RETURN false;
  END IF;

  UPDATE public.buyer_meter_usage
    SET usage = jsonb_set(v_usage, ARRAY[p_meter], to_jsonb(v_used + 1)),
        reset_at = CASE WHEN v_rolled THEN now() ELSE reset_at END,
        updated_at = now()
    WHERE user_id = p_user_id;
  RETURN true;
END;
$$;

-- Give a reserved unit back when the work it paid for failed (floor at 0).
CREATE OR REPLACE FUNCTION public.refund_buyer_meter(p_user_id uuid, p_meter text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usage jsonb;
  v_used  int;
BEGIN
  SELECT usage INTO v_usage FROM public.buyer_meter_usage WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_used := COALESCE((v_usage ->> p_meter)::int, 0);
  IF v_used <= 0 THEN RETURN; END IF;
  UPDATE public.buyer_meter_usage
    SET usage = jsonb_set(v_usage, ARRAY[p_meter], to_jsonb(v_used - 1)),
        updated_at = now()
    WHERE user_id = p_user_id;
END;
$$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00413')
ON CONFLICT (version) DO NOTHING;
