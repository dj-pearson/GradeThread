-- US-1524: rotating a "tag" / "tag_2" / "certificate" photo (a SENSITIVE type in
-- the PRIVATE `submission-images` bucket) fails with HTTP 400, while every
-- non-sensitive photo (public `item-photos` bucket) rotates fine.
--
-- Root cause: PhotoRotateService re-uploads the rotated bytes to the SAME storage
-- path with `x-upsert: true`. On an object that already exists that is an UPDATE
-- on `storage.objects`. The `submission-images` bucket had per-user-folder INSERT
-- (00001) + SELECT (00001) + DELETE (00001) policies, plus workspace-member INSERT
-- + SELECT (00042) — but NO UPDATE policy for either. So the upsert-overwrite was
-- denied by RLS → 400. `item-photos` rotates fine because it has owner (00017) and
-- workspace-member (00042) UPDATE policies.
--
-- Fix: add the missing per-user-folder UPDATE policies for `submission-images`,
-- mirroring the item-photos owner (00017) + member (00042) update policies. Idempotent.

-- Owner can overwrite (rotate) objects in their own folder.
DROP POLICY IF EXISTS "submission-images owner update" ON storage.objects;
CREATE POLICY "submission-images owner update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'submission-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'submission-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Workspace members (>= member) can overwrite objects in the OWNER's folder —
-- parity with their existing INSERT/SELECT (00042) and with item-photos member
-- update. Rotating is an overwrite, not a delete (members still cannot DELETE).
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
  )
  WITH CHECK (
    bucket_id = 'submission-images'
    AND public.is_workspace_member_with_role(
      ((storage.foldername(name))[1])::uuid,
      'member'
    )
  );

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00333') ON CONFLICT DO NOTHING;
