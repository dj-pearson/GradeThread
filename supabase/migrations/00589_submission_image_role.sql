-- US-2471: the photo ROLE reaches the grader.
--
-- `submission_images.image_type` is a Postgres ENUM (00001, grown by 00103) and
-- the photo-tags epic (US-2461) deliberately stopped growing enums — a role is
-- data, not a type. So the role travels in its own open-text column, exactly as
-- `item_photos.photo_role` does (00587), and the two stay the same vocabulary.
--
-- NULL means "no qualifier", which is the correct answer for `front`, `back`
-- and `defect`. It is also what every historical row keeps: this migration does
-- NOT rewrite `image_type` on existing rows. Those rows are the evidence behind
-- grades that have already been issued and are served by the public API v1
-- contract (`lib/api-grade-ingest.ts`, `lib/openapi-spec.ts`), so rewriting them
-- would change what a past submission says it contained.
--
-- No index. Submission images are always read as "every image for this
-- submission", so an index on the role would be write cost with no reader.
--
-- Contract + full role vocabulary: vault/20-domain/listing-photos.md

ALTER TABLE public.submission_images
  ADD COLUMN IF NOT EXISTS image_role text;

COMMENT ON COLUMN public.submission_images.image_role IS
  'Open-text qualifier for image_type (US-2471), mirroring item_photos.photo_role. NULL = no qualifier. Vocabulary lives in src/lib/photo-roles.ts, not in a constraint.';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00589') on conflict do nothing;
