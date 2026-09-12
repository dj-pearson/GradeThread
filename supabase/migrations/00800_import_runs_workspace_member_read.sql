-- US-3316: a workspace seat can read the import runs it already sees.
--
-- flipdesk_import_runs shipped with one SELECT policy, 00592's "Users read own
-- import runs", which is owner-only. The activation checklist's import step is
-- done when a 'completed' run exists, and the browser counts that row through
-- RLS, so a member on somebody else's workspace got 0 and the step could never
-- tick. Its sibling steps all can: submissions, inventory_items and sources
-- each carry a "Workspace members can view ..." policy.
--
-- THE DECISION, because widening a read deserves one rather than an assumption
-- (AC1). A viewer ALREADY reads every field of every run in this workspace:
-- GET /api/flipdesk/import/runs sits behind workspaceMiddleware with no role
-- floor above viewer, scopes on workspaceOwnerId, and returns origin, the six
-- counters, the error and undone_at. This policy therefore grants a viewer
-- nothing the product withholds today; it removes a disagreement between the
-- two read paths. The row carries no file name and no file bytes, and nothing
-- client-side selects payload, so the widened detail is one origin string and
-- six integers.
--
-- SCOPE IS RUNS ONLY. flipdesk_import_effects stays owner-only: it holds the
-- pre-import values of every column a fill-only re-import overwrote, it is read
-- only by the service role, and no client query touches it. No checklist step
-- reads it, so there is no reason to widen it.
--
-- The predicate is copied from inventory_items' live "Workspace members can
-- view inventory" (00451's initplan form: the owner fast-path disjunct plus the
-- helper), read back from pg_policies rather than off the migration that wrote
-- it, so the checklist's import step and its item step cannot drift apart.
-- flipdesk_expenses still uses the older bare-helper form from 00042. That is
-- semantically identical but makes the planner call the SECURITY DEFINER helper
-- for owner rows too, and it is not the shape the sibling step uses.
--
-- 00592's owner-only policy stays. Two permissive SELECT policies OR together,
-- and dropping the narrow one would put every owner read through the helper,
-- which is the reason 00451 added the disjunct instead of replacing it.

DROP POLICY IF EXISTS "Workspace members can view import runs"
  ON public.flipdesk_import_runs;
CREATE POLICY "Workspace members can view import runs"
  ON public.flipdesk_import_runs FOR SELECT
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'viewer')
  );

COMMENT ON TABLE public.flipdesk_import_runs IS
  'US-2518: one durable CSV inventory import. payload holds the mapped rows so the worker survives the browser closing; the counters are derived by re-reading effect rows, never trusted from memory. US-3316: a workspace viewer reads these rows, matching what GET /api/flipdesk/import/runs already returns to that viewer; the effect rows stay owner-only.';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00800') on conflict do nothing;
