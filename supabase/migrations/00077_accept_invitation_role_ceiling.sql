-- US-351: enforce the role ceiling when an invitation is accepted.
--
-- accept_workspace_invitation() (migration 00042) inserts the invitation's role
-- into workspace_members verbatim. The table's CHECK (role <> 'owner') already
-- blocks promotion to owner, but the accept path itself did not assert the
-- "admin is the ceiling" invariant. This recreates the function with an
-- explicit guard so a stored invitation carrying anything above 'admin' (e.g.
-- a row written directly to the DB, or a future role added above admin) can
-- never be turned into a membership. Defense in depth alongside the edge
-- invite/resend caps.

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
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
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

  -- US-351: role ceiling. 'admin' is the highest role that can be granted via an
  -- invitation; 'owner' is implicit and never a workspace_members row.
  IF v_inv.role NOT IN ('viewer', 'member', 'listing_manager', 'admin') THEN
    RAISE EXCEPTION 'Invitation role % exceeds the allowed ceiling', v_inv.role
      USING ERRCODE = '42501';
  END IF;

  -- Upsert: if a membership row already exists, update the role to the
  -- invited role. This lets owners re-invite an existing member to change
  -- their role through the invitation flow if they want to.
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
