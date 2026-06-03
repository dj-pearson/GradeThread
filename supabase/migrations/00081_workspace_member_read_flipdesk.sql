-- US-455: let workspace members (viewer+) READ the owner's repricing
-- suggestions (00059) and sync history (00073). Both tables were owner-only
-- (auth.uid() = user_id), inconsistent with the 00042 convention that mirrors
-- member access at the RLS layer for every tenant table.
--
-- SELECT-only and ADDITIVE: mutations stay owner-scoped. The FlipDesk edge uses
-- the service-role client (which bypasses RLS) and already scopes reads by the
-- workspace owner, so this is defense-in-depth + consistency — it aligns the
-- RLS layer with the edge behavior and future-proofs any direct-client read.
-- A non-member non-owner still matches no SELECT policy and therefore sees
-- nothing (the property the cross-tenant test asserts at the API boundary).
--
-- is_workspace_member_with_role(user_id, 'viewer') is SECURITY DEFINER and
-- returns true for the owner OR any member at viewer rank or above; for a
-- non-member non-owner it returns false. (00042.)

DROP POLICY IF EXISTS "Workspace members can view repricing suggestions"
  ON public.repricing_suggestions;
CREATE POLICY "Workspace members can view repricing suggestions"
  ON public.repricing_suggestions FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));

DROP POLICY IF EXISTS "Workspace members can view sync runs"
  ON public.flipdesk_sync_runs;
CREATE POLICY "Workspace members can view sync runs"
  ON public.flipdesk_sync_runs FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));
