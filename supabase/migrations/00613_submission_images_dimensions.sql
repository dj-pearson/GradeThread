-- US-2135 AC3: record the pixel dimensions actually delivered per image.
--
-- The AC asks to "measure the delivered pixel density per macro region and
-- record it, so confidence can be conditioned on real evidence quality rather
-- than assumed". For an authenticity macro slot the whole photo IS the region
-- (serial, marking, surface, corner and sole are dedicated close-ups, which is
-- the reason the re-read path rather than the crop path was the right parent
-- for AC2), so the delivered density of that region is just the stored image's
-- own width and height.
--
-- NOTHING NEW IS MEASURED. validateImageUpload() already parses width/height out
-- of the JPEG/PNG/WebP header on every upload, to enforce the decompression-bomb
-- ceiling and the US-529 minimum-long-edge floor. It returns them and grade.ts
-- has been discarding them. This migration is the column to keep them in.
--
-- SERVER-OBSERVED, NOT CLIENT-CLAIMED, which is the difference from
-- quality_score beside it. That one is measured client-side on the compressed
-- bytes and sent in the form, so an older client or a canvas that cannot decode
-- sends nothing and readers must treat NULL as unknown. These two are parsed
-- from the bytes the server is about to store, so they are as trustworthy as the
-- file itself and need no client cooperation to start working.
--
-- NULL still means unknown, for two reasons that are not "old client":
--   1. Every row written before this migration.
--   2. A format whose header this parser does not read. The parser returns
--      null rather than guessing, and the caller must not read that as zero.
--      Same coercion trap as US-2443's fake -9 factor delta: Number(null) is 0
--      and finite, so a naive reader turns "unknown" into "worst possible".
--
-- Deliberately NOT a CHECK on plausible ranges. The dimension ceiling and floor
-- are enforced at upload where a violation can still be refused; a constraint
-- here would only convert a future parser bug into a failed INSERT on a
-- submission the customer has already paid for.

ALTER TABLE public.submission_images
  ADD COLUMN IF NOT EXISTS width int,
  ADD COLUMN IF NOT EXISTS height int;

COMMENT ON COLUMN public.submission_images.width IS
  'US-2135 AC3: pixel width parsed from the stored image header by '
  'validateImageUpload. Server-observed. NULL = unknown (pre-00613 row, or a '
  'format whose header the parser does not read) and must never be read as 0.';

COMMENT ON COLUMN public.submission_images.height IS
  'US-2135 AC3: pixel height parsed from the stored image header by '
  'validateImageUpload. Server-observed. NULL = unknown (pre-00613 row, or a '
  'format whose header the parser does not read) and must never be read as 0.';

insert into public.applied_migrations (version) values ('00613') on conflict do nothing;
