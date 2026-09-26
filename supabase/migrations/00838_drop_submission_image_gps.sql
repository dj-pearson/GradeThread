-- US-3520: seller GPS was stored in submission_images.exif.
--
-- The web client read GPS from each photo's EXIF and sent it beside the
-- upload, and /api/grade/submit kept it (routes/grade.ts sanitizeExif). Nothing
-- in grading, forensics or the admin UI reads it, so it was a seller's home
-- location sitting in a table staff can query, for no purpose. The edge no
-- longer stores it and the client no longer reads it; this removes the copies
-- already stored.
--
-- Idempotent: the second run matches no rows.

UPDATE public.submission_images
SET exif = NULLIF(exif - 'gps', '{}'::jsonb)
WHERE exif ? 'gps';

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00838') ON CONFLICT DO NOTHING;
