-- Perceptual hash on submission images for photo-reuse detection (US-337).
--
-- A 64-bit difference hash (dHash), stored as 16 lowercase hex chars, computed
-- client-side from the orientation-corrected pixels at upload. Lets the grading
-- pipeline detect the SAME photo being reused across submissions/sellers
-- (stolen or recycled listings, stock photos) via Hamming distance — a far
-- stronger signal than EXIF for that threat, and fully under our control.
--
-- Nullable: historical rows and any upload where client-side hashing failed
-- (e.g. HEIC decode fallback) simply don't participate in reuse matching.

ALTER TABLE public.submission_images
  ADD COLUMN IF NOT EXISTS phash text;

COMMENT ON COLUMN public.submission_images.phash IS
  '64-bit dHash (16 hex chars) of the photo, computed client-side. Powers '
  'cross-submission photo-reuse detection (US-337). NULL when unavailable.';

-- Reuse matching scans recent hashed rows (Hamming distance in the edge), so an
-- index on the partial set keeps that candidate fetch cheap as volume grows.
CREATE INDEX IF NOT EXISTS idx_submission_images_phash
  ON public.submission_images(created_at DESC)
  WHERE phash IS NOT NULL;
