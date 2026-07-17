-- Video distribution for social posts.
--
-- A social_posts row can now carry a VIDEO instead of (or alongside) a still
-- card, so the content engine can fan clips out to video-native networks
-- (TikTok / Instagram Reels / Facebook video) through the existing Make.com
-- webhook. The clip lives in a new PUBLIC `content-videos` bucket because the
-- downstream Make.com scenario and the platform APIs pull the media by URL —
-- they can't see a private bucket.
--
-- Two pieces:
--   1. content-videos storage bucket (public read; admin write mirrors
--      content-images — real writes go via a service-role signed upload URL).
--   2. social_posts.{media_type, video_url, video_path} columns. media_type
--      defaults to 'image' so every existing row is unchanged and keeps
--      publishing as a still-card post.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT / DROP POLICY IF EXISTS) — safe to
-- re-run the whole migrations directory.

-- ── STORAGE BUCKET ─────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'content-videos',
  'content-videos',
  true,
  524288000, -- 500 MB; well above our marketing clips, under platform ceilings
  ARRAY['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']
)
ON CONFLICT (id) DO NOTHING;

-- Public read so Make.com + the platform APIs can fetch the clip by URL.
DROP POLICY IF EXISTS "content-videos public read" ON storage.objects;
CREATE POLICY "content-videos public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'content-videos');

-- Admin write/update/delete (mirrors content-images). Service-role bypasses
-- RLS, and the signed upload URL the edge hands out is pre-authorized, so this
-- only gates a hypothetical direct-JWT admin upload. Non-admins can't traverse.
DROP POLICY IF EXISTS "content-videos admin insert" ON storage.objects;
CREATE POLICY "content-videos admin insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'content-videos' AND public.is_admin());

DROP POLICY IF EXISTS "content-videos admin update" ON storage.objects;
CREATE POLICY "content-videos admin update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'content-videos' AND public.is_admin());

DROP POLICY IF EXISTS "content-videos admin delete" ON storage.objects;
CREATE POLICY "content-videos admin delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'content-videos' AND public.is_admin());

-- ── SOCIAL_POSTS VIDEO COLUMNS ─────────────────────────────
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS video_url  text,
  ADD COLUMN IF NOT EXISTS video_path text;

-- Constrain media_type to the two supported kinds. Dropped-and-recreated so a
-- re-run is idempotent and future values can extend it via this same block.
ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_media_type_check;
ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_media_type_check
  CHECK (media_type IN ('image', 'video'));

-- US-1108 self-record: keep the edge boot guard truthful regardless of how the
-- SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00461')
ON CONFLICT (version) DO NOTHING;
