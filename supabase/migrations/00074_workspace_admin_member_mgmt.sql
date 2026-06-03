-- Let workspace admins (not just the owner) manage team members.
--
-- Until now workspace_members UPDATE/DELETE were owner-only, so a delegated
-- 'admin' could invite members (via the edge invite endpoint, which inserts
-- through the SECURITY DEFINER accept-invitation RPC) but could NOT change a
-- member's role or remove one — those direct-client writes failed RLS. The
-- Team UI already exposes the controls to admins (manage_members capability),
-- so this aligns the database with the intended permission.
--
-- Guards that keep this safe (a delegated admin still can't escalate past the
-- owner or impact anything outside the workspace):
--   * The workspace OWNER is never a workspace_members row (it's rendered as a
--     synthetic row in the UI), so admins can never demote or remove the owner.
--   * CHECK (role <> 'owner') on the table (migration 00042) blocks promoting
--     anyone — including oneself — to owner, so 'admin' is the ceiling.
--   * USING + WITH CHECK both require the caller to be an admin OF THAT
--     workspace, so an admin of workspace A can't touch workspace B's members.
--
-- is_workspace_member_with_role() is SECURITY DEFINER (migration 00042), so
-- referencing workspace_members inside these policies does not recurse through
-- RLS. The owner always satisfies the check, so these are additive to the
-- existing owner-only policies.

CREATE POLICY "Admins can update workspace members"
  ON public.workspace_members FOR UPDATE
  USING (public.is_workspace_member_with_role(owner_id, 'admin'))
  WITH CHECK (public.is_workspace_member_with_role(owner_id, 'admin'));

CREATE POLICY "Admins can delete workspace members"
  ON public.workspace_members FOR DELETE
  USING (public.is_workspace_member_with_role(owner_id, 'admin'));
