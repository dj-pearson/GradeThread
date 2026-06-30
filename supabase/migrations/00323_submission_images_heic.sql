-- Allow HEIC/HEIF in the PRIVATE submission-images bucket.
--
-- The two storage buckets had an asymmetric MIME allow-list:
--   • item-photos       (PUBLIC, listing imagery): jpeg, png, webp, heic, heif
--   • submission-images (PRIVATE, sensitive close-ups): jpeg, png, webp
--
-- Sensitive slots (tag / tag_2 / certificate — care+size labels, grading
-- labels) route to submission-images (see ios PhotoStorageBucket). Those are
-- exactly the iOS-native close-ups most likely to arrive as HEIC, so the private
-- bucket — and ONLY the private bucket — could reject a tag upload that the same
-- bytes would land fine as a front/back shot in item-photos. This aligns the two
-- buckets so a sensitive slot is never stricter than a public one.
--
-- Security posture is unchanged: submission-images stays PRIVATE (read only via
-- short-TTL signed URLs), the per-user-folder RLS still applies, and the edge
-- upload path still sniffs magic bytes + strips EXIF before storing. HEIC/HEIF
-- are still images — widening the allow-list does not loosen tenant isolation.
--
-- Idempotent: setting the array to a fixed value converges on any prior state.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
WHERE id = 'submission-images';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00323') ON CONFLICT DO NOTHING;
