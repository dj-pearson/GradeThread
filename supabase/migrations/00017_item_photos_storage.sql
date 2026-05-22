-- Storage bucket for FlipDesk item photos.
-- Path convention: {user_id}/{item_id}/{photo_type}_{timestamp}.{ext}
-- Public read (so listing/certificate pages can show them); writes restricted
-- to the owning user via the first path segment.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'item-photos',
  'item-photos',
  true,
  10485760, -- 10 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO NOTHING;

-- Anyone can read (bucket is public).
CREATE POLICY "item-photos public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'item-photos');

-- Writes: only into a folder named after the caller's own user id.
CREATE POLICY "item-photos owner insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'item-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "item-photos owner update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'item-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "item-photos owner delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'item-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
