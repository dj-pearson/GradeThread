-- US-3513: a seller could replace the photos behind a certificate after grading.
--
-- Grading photos live at `{ownerId}/{submissionId}/{type}_{ts}.{ext}` in the
-- private `submission-images` bucket. Only the edge writes there, with the
-- service role, which bypasses these policies. But the client-facing policies
-- let the owner INSERT (00001), DELETE (00001) and UPDATE (00333) anything in
-- their folder, and a workspace member INSERT (00042) and UPDATE (00333). So a
-- seller could grade a clean jacket, then overwrite (or delete and re-upload)
-- the front and back with photos of a worse one, and the certificate gallery
-- would serve those under the original grade.
--
-- The same bucket also holds sensitive ITEM photos from iOS/Android/web at
-- `{ownerId}/{itemId}/...` (US-979), and those must stay writable: rotating a
-- tag photo is why 00333 exists. So the lock keys on the path, not the bucket:
-- a client write is refused when the second folder segment is a submission id.
-- No client ever writes into a submission folder, so nothing legitimate breaks.

CREATE OR REPLACE FUNCTION public.is_submission_photo_path(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.submissions s
    WHERE s.id::text = (storage.foldername(p_name))[2]
  );
$$;

REVOKE ALL ON FUNCTION public.is_submission_photo_path(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_submission_photo_path(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_submission_photo_path(text) TO authenticated, service_role;

-- Owner INSERT (was 00001).
DROP POLICY IF EXISTS "Users can upload to own folder" ON storage.objects;
CREATE POLICY "Users can upload to own folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'submission-images'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
    AND NOT public.is_submission_photo_path(name)
  );

-- Owner DELETE (was 00001). Deleting then re-uploading is the same swap.
DROP POLICY IF EXISTS "Users can delete own files" ON storage.objects;
CREATE POLICY "Users can delete own files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'submission-images'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
    AND NOT public.is_submission_photo_path(name)
  );

-- Member INSERT (was 00042).
DROP POLICY IF EXISTS "Workspace members can upload to owner folder" ON storage.objects;
CREATE POLICY "Workspace members can upload to owner folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'submission-images'
    AND public.is_workspace_member_with_role(
      ((storage.foldername(name))[1])::uuid,
      'member'
    )
    AND NOT public.is_submission_photo_path(name)
  );

-- Owner UPDATE (was 00333).
DROP POLICY IF EXISTS "submission-images owner update" ON storage.objects;
CREATE POLICY "submission-images owner update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'submission-images'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
    AND NOT public.is_submission_photo_path(name)
  )
  WITH CHECK (
    bucket_id = 'submission-images'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
    AND NOT public.is_submission_photo_path(name)
  );

-- Member UPDATE (was 00333).
DROP POLICY IF EXISTS "Workspace members can update owner submission-images" ON storage.objects;
CREATE POLICY "Workspace members can update owner submission-images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'submission-images'
    AND public.is_workspace_member_with_role(
      ((storage.foldername(name))[1])::uuid,
      'member'
    )
    AND NOT public.is_submission_photo_path(name)
  )
  WITH CHECK (
    bucket_id = 'submission-images'
    AND public.is_workspace_member_with_role(
      ((storage.foldername(name))[1])::uuid,
      'member'
    )
    AND NOT public.is_submission_photo_path(name)
  );

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00837') ON CONFLICT DO NOTHING;
