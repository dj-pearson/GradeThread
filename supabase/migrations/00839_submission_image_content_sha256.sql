-- US-3516: record the SHA-256 of each graded photo's stored bytes.
--
-- Certificate integrity v5 (services/edge-functions/src/lib/cert-photo-seal.ts)
-- seals the sorted list of `${image_type}:${content_sha256}` and the public
-- verify re-hashes the stored files against it, so a certificate stops
-- verifying if its photos change. Every edge upload path writes this column
-- (grade.ts, api-v1.ts, api-grade-ingest.ts, grading-submit.ts), so the edge
-- that ships with this file must not run before it: the schema-version boot
-- guard holds it back.
--
-- NULL on rows uploaded before this migration. Those rows are simply not part
-- of any seal, and certificates sealed before it keep verifying at v1-v4.

ALTER TABLE public.submission_images
  ADD COLUMN IF NOT EXISTS content_sha256 text;

COMMENT ON COLUMN public.submission_images.content_sha256 IS
  'US-3516: hex SHA-256 of the stored (EXIF-stripped) bytes, sealed into certificate integrity v5.';

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00839') ON CONFLICT DO NOTHING;
