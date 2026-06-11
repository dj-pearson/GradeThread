-- US-572: Dedicated PUBLIC bucket for user avatars.
--
-- Avatars were previously uploaded to the PRIVATE `submission-images` bucket and
-- served via getPublicUrl() — which yields an unfetchable/leaky link on a private
-- bucket and violates the CLAUDE.md storage contract (signed-URL-only for
-- submission-images). Avatars are user-controlled profile imagery that is meant
-- to be publicly visible, so they belong in their own public bucket — NOT in
-- `item-photos` (reserved for seller-intended listing imagery) and NOT in the
-- private grading bucket.
--
-- Path convention: {user_id}/avatar_{timestamp}.{ext}

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  2097152, -- 2 MB (matches the client-side cap in settings.tsx)
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Anyone can read (bucket is public).
CREATE POLICY "avatars public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- Writes: only into a folder named after the caller's own user id.
CREATE POLICY "avatars owner insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars owner update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "avatars owner delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
