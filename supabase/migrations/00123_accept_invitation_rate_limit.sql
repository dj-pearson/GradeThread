-- US-799: throttle invitation-accept attempts.
--
-- accept_workspace_invitation is called DIRECTLY from the SPA (SECURITY DEFINER,
-- keyed on auth.uid()) — it never transits the edge service, so the edge's
-- IP-based rate limiter can't see it. We add a per-authenticated-user throttle
-- INSIDE the RPC using the same shared rate_limit_counters store the edge uses
-- (increment_rate_limit, migration 00045). IP isn't available in this execution
-- context; the authenticated user is the stronger dimension for an auth-required
-- action anyway. 30 attempts/minute is far above any legitimate use (a user
-- accepts an invite once) but stops an account hammering the endpoint.
--
-- This re-declares the full function from 00085 (seat-cap enforcement) with the
-- throttle added right after the authentication check — the body is otherwise
-- byte-for-byte identical so no other behavior changes.

CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(invitation_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_user_email text;
  v_inv public.workspace_invitations%ROWTYPE;
  v_plan text;
  v_status text;
  v_trial_ends timestamptz;
  v_effective_plan text;
  v_seat_cap integer;
  v_seat_count integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- US-799: per-user accept-attempt throttle (shared rate_limit_counters store).
  IF public.increment_rate_limit(
       'accept-invite|user:' || v_user_id::text,
       date_trunc('minute', now())
     ) > 30 THEN
    RAISE EXCEPTION 'Too many invitation attempts. Please wait a minute and try again.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM public.workspace_invitations
  WHERE token = invitation_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation already accepted' USING ERRCODE = 'P0001';
  END IF;
  IF v_inv.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has been revoked' USING ERRCODE = 'P0001';
  END IF;
  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = 'P0001';
  END IF;

  IF lower(v_inv.email) <> lower(v_user_email) THEN
    RAISE EXCEPTION 'Invitation email does not match your account' USING ERRCODE = '42501';
  END IF;

  IF v_inv.owner_id = v_user_id THEN
    RAISE EXCEPTION 'You cannot invite yourself' USING ERRCODE = 'P0001';
  END IF;

  -- US-351: role ceiling. 'admin' is the highest role grantable via invitation.
  IF v_inv.role NOT IN ('viewer', 'member', 'listing_manager', 'admin') THEN
    RAISE EXCEPTION 'Invitation role % exceeds the allowed ceiling', v_inv.role
      USING ERRCODE = '42501';
  END IF;

  -- US-388: seat cap, only when this acceptance ADDS a new member.
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE owner_id = v_inv.owner_id AND member_id = v_user_id
  ) THEN
    SELECT flipdesk_plan::text, subscription_status::text, trial_ends_at
      INTO v_plan, v_status, v_trial_ends
      FROM public.users
      WHERE id = v_inv.owner_id;

    v_effective_plan := CASE
      WHEN v_status = 'paused' THEN 'free'
      WHEN v_status = 'trialing'
        AND v_trial_ends IS NOT NULL
        AND v_trial_ends <= now() THEN 'free'
      WHEN v_status IN ('none', 'canceled', 'incomplete') THEN 'free'
      ELSE v_plan
    END;

    v_seat_cap := CASE v_effective_plan WHEN 'business' THEN 10 ELSE 0 END;

    SELECT count(*) INTO v_seat_count
      FROM public.workspace_members
      WHERE owner_id = v_inv.owner_id;

    IF v_seat_count >= v_seat_cap THEN
      RAISE EXCEPTION 'Workspace seat limit reached for the owner''s plan'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Upsert: an existing membership is a role change (no new seat consumed).
  INSERT INTO public.workspace_members (owner_id, member_id, role, invited_by)
  VALUES (v_inv.owner_id, v_user_id, v_inv.role, v_inv.invited_by)
  ON CONFLICT (owner_id, member_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = now();

  UPDATE public.workspace_invitations
  SET accepted_at = now(), accepted_by = v_user_id
  WHERE id = v_inv.id;

  RETURN v_inv.owner_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_workspace_invitation(text) TO authenticated;
