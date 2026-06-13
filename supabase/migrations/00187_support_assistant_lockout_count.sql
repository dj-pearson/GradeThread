-- US-836: abuse detection & enforced thresholds for the AI Support Assistant.
--
-- The abuse pipeline (services/edge-functions/src/lib/support-abuse.ts) sets
-- users.support_assistant_locked_until (added in 00185) with a GRADUATED cooldown:
-- the first lockout is short, repeats get longer. To pick the right tier we need
-- to know how many times this user has been locked before — a durable counter
-- that survives the cooldown expiring (locked_until clears, the count does not).
--
-- One column + one atomic RPC. RLS/security is unchanged: support_assistant_*
-- columns on users are written ONLY by the service-role edge client.

-- Durable count of prior lockouts (never reset by cooldown expiry). Drives the
-- graduated-cooldown ladder in support-abuse.ts cooldownMsForOffense().
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS support_assistant_lockout_count integer NOT NULL DEFAULT 0;

-- Atomically apply a lockout: set the cooldown deadline AND bump the durable
-- lockout counter in one statement (so concurrent edge replicas can't double- or
-- under-count). Returns the post-increment lockout count for logging/alerting.
CREATE OR REPLACE FUNCTION public.apply_support_assistant_lockout(
  p_user_id uuid,
  p_locked_until timestamptz
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.users
     SET support_assistant_locked_until = p_locked_until,
         support_assistant_lockout_count = support_assistant_lockout_count + 1
   WHERE id = p_user_id
  RETURNING support_assistant_lockout_count INTO v_count;

  RETURN COALESCE(v_count, 0);
END;
$$;
