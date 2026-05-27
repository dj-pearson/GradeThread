-- Thumbnail variants for item_photos.
--
-- Thumbnails are generated client-side at upload time (canvas re-encode,
-- ~320px wide) and stored alongside the full-resolution image under the
-- same `item-photos` bucket. Grid views render `thumbnail_url ?? photo_url`,
-- so existing rows (which have only the full-res URL) continue to work
-- unmodified.
--
-- width/height capture the FULL-RESOLUTION dimensions, populated at upload
-- time. Useful for layout (aspect ratios) and future image-pipeline work.

ALTER TABLE public.item_photos
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS thumbnail_storage_path text,
  ADD COLUMN IF NOT EXISTS width integer,
  ADD COLUMN IF NOT EXISTS height integer,
  ADD COLUMN IF NOT EXISTS bytes integer;
