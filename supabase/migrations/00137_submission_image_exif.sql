-- Original-image + EXIF retention pipeline (US-339).
--
-- The grading upload path re-encodes every photo client-side (image-utils.ts
-- compressImage), which strips EXIF and forensic signal. To enable provenance /
-- authenticity features (US-340 Verified Capture, US-341 forensic ML pass) we
-- now capture two new things per image, both BEFORE compression:
--
--   exif                  Structured provenance read from the original file
--                         (camera make/model, capture time, GPS if present).
--                         Sanitized + bounded server-side. Nullable — absence is
--                         normal (re-shared photos, screenshots, stripped
--                         uploads) and is never penalized on its own.
--
--   original_storage_path Path to the retained ORIGINAL (uncompressed,
--                         EXIF-intact) file in the PRIVATE submission-images
--                         bucket, for server-side forensic use only. Null unless
--                         original retention is enabled (RETAIN_ORIGINAL_IMAGES).
--
-- PRIVACY / RETENTION: GPS and device metadata are privacy-sensitive. They live
-- only in this access-controlled, tenant-scoped row and the private bucket; they
-- are NEVER exposed publicly, served to buyers, or returned by the public API.
-- Originals follow the same per-user-folder RLS + signed-URL access as the
-- compressed grading images and are removed with the submission (ON DELETE
-- CASCADE on submission_images + storage cleanup on the delete paths).

ALTER TABLE public.submission_images
  ADD COLUMN IF NOT EXISTS exif jsonb,
  ADD COLUMN IF NOT EXISTS original_storage_path text;

COMMENT ON COLUMN public.submission_images.exif IS
  'Structured provenance EXIF (camera make/model, DateTimeOriginal, GPS) read '
  'client-side from the original file before compression (US-339). NULL is '
  'normal. Privacy-sensitive (GPS) — never exposed publicly or to buyers.';

COMMENT ON COLUMN public.submission_images.original_storage_path IS
  'Path in the PRIVATE submission-images bucket to the retained uncompressed '
  'original (EXIF intact) for server-side forensic use (US-339). NULL unless '
  'original retention is enabled. Never public, never served to buyers.';
