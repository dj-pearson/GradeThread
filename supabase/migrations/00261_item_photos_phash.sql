-- 00261_item_photos_phash.sql
--
-- US-1099: relist detection via listing-image hash. To recognize when a seller
-- drafts a NEW listing using the SAME/near-identical photos as a garment we've
-- already graded (and minted a passport for), we perceptually hash the listing's
-- photos and compare them against the garment fingerprints (US-1097). This adds
-- a nullable, cached perceptual-hash column to item_photos so the hash is
-- computed once (on demand, server-side) and reused by later detections / the
-- admin fraud sweep (US-1103) — mirroring submission_images.phash (00062).
--
-- The hash is the SAME 64-bit dHash space (16 hex chars) used platform-wide
-- (perceptual-hash.ts / image-utils.ts), so item-photo hashes are directly
-- comparable to fingerprint hashes. NULL = not yet hashed (or undecodable);
-- detection treats NULL as "skip", so this is purely additive and safe.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraint + IF NOT EXISTS
-- index. Applies cleanly on a fresh schema (db verify lane).

BEGIN;

ALTER TABLE public.item_photos
  ADD COLUMN IF NOT EXISTS phash text;

COMMENT ON COLUMN public.item_photos.phash IS
  'US-1099: cached 64-bit perceptual dHash (16 hex chars) of this listing photo, '
  'computed server-side on demand. Comparable to garment_fingerprints phashes for '
  'relist detection. NULL until hashed (or if the image was undecodable).';

-- Enforce the 16-hex shape so a malformed value can never poison a Hamming
-- comparison (NULL stays allowed). Guarded so re-running is a no-op.
DO $$ BEGIN
  ALTER TABLE public.item_photos
    ADD CONSTRAINT item_photos_phash_format
    CHECK (phash IS NULL OR phash ~ '^[0-9a-f]{16}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partial index: relist detection / fraud sweeps scan only the hashed rows.
CREATE INDEX IF NOT EXISTS idx_item_photos_phash
  ON public.item_photos(phash) WHERE phash IS NOT NULL;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync no
-- matter how this migration is applied. Version = this file's NNNNN prefix.
INSERT INTO public.applied_migrations (version) VALUES ('00261')
ON CONFLICT (version) DO NOTHING;

COMMIT;
