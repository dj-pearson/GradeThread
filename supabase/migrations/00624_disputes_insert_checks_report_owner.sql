-- US-2670: the disputes INSERT policies never look at grade_report_id.
--
-- Both existing policies gate on the user_id COLUMN alone -- 00001's
-- "Users can create disputes" WITH CHECK (auth.uid() = user_id), and 00042's
-- "Workspace members can create disputes" WITH CHECK
-- is_workspace_member_with_role(user_id, 'member'). Neither reads
-- grade_report_id, so an authenticated caller who sets user_id to their OWN id
-- could file a dispute against any grade report that exists, including another
-- seller's. routes/grade.ts has always loaded the submission scoped to the
-- owner before filing, so the policy was carrying no weight rather than
-- failing; this is the defence-in-depth half.
--
-- THE CHECK IS ON THE ROW'S user_id, NOT auth.uid(), which is what keeps the
-- workspace policy working: a member files for the OWNER, so the row's user_id
-- is the owner's id and the report must belong to that same owner.
--
-- WHY A SECURITY DEFINER HELPER RATHER THAN AN INLINE EXISTS: a subquery inside
-- a policy is evaluated with the referenced table's RLS applied for the calling
-- role, so an inline join through submissions would depend on the caller also
-- holding a SELECT policy there. is_workspace_member_with_role (00042) solves
-- the same problem the same way.
--
-- NO REVOKE, DELIBERATELY (US-2403): a denied function call from anon or
-- authenticated segfaults this Postgres image, and this helper is an RLS
-- predicate, which runs as the QUERYING role -- so it has to stay executable by
-- anon and authenticated exactly like is_workspace_member_with_role. The
-- explicit GRANT below is what the US-2282 AC4 guard requires; it states the
-- CREATE FUNCTION default rather than widening anything.
--
-- Ownership runs through submissions because grade_reports has no user_id.

CREATE OR REPLACE FUNCTION public.grade_report_belongs_to(
  p_grade_report_id uuid,
  p_owner_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.grade_reports gr
    JOIN public.submissions s ON s.id = gr.submission_id
    WHERE gr.id = p_grade_report_id
      AND s.user_id = p_owner_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.grade_report_belongs_to(uuid, uuid)
  TO authenticated, anon, service_role;

DROP POLICY IF EXISTS "Users can create disputes" ON public.disputes;
CREATE POLICY "Users can create disputes"
  ON public.disputes FOR INSERT
  WITH CHECK (
    (select auth.uid()) = user_id
    AND public.grade_report_belongs_to(grade_report_id, user_id)
  );

DROP POLICY IF EXISTS "Workspace members can create disputes" ON public.disputes;
CREATE POLICY "Workspace members can create disputes"
  ON public.disputes FOR INSERT
  WITH CHECK (
    public.is_workspace_member_with_role(user_id, 'member')
    AND public.grade_report_belongs_to(grade_report_id, user_id)
  );

insert into public.applied_migrations (version) values ('00624') on conflict do nothing;
