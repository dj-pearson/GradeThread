-- US-3540 follow-up: undo 00837's REVOKE on is_submission_photo_path, which
-- is a database-crash entry point on this Postgres image (US-2403).
--
-- 00837 made the function SECURITY DEFINER and revoked EXECUTE from PUBLIC and
-- anon. On this image a permission-denied error for a role in
-- supautils.hint_roles SEGFAULTS the backend while building the GRANT hint,
-- and the storage INSERT/DELETE policies that call this function have no TO
-- clause, so an anonymous upload attempt to submission-images reaches it.
-- That is one request with the browser's anon key restarting the database.
--
-- The fix is the one 00686, 00720 and 00726 used: restore the default EXECUTE
-- and put the authorization somewhere else. Here that is simpler, because the
-- function does not need to be DEFINER at all. It only has to answer for
-- folders the caller may write to (their own, or a workspace owner's), and the
-- existing submissions SELECT policies ("Users can view own submissions",
-- "Workspace members can view submissions") already show exactly those rows.
-- As SECURITY INVOKER it sees what the caller sees, which is the same answer
-- for every path the storage policies let through, and nothing for anon.
--
-- Idempotent: CREATE OR REPLACE, and a GRANT that is a no-op when held.

CREATE OR REPLACE FUNCTION public.is_submission_photo_path(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.submissions s
    WHERE s.id::text = (storage.foldername(p_name))[2]
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_submission_photo_path(text) TO PUBLIC;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00846') ON CONFLICT DO NOTHING;
