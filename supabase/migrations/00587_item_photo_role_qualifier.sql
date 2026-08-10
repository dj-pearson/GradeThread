-- US-2462: the photo ROLE qualifier.
--
-- `item_photos.photo_role` is open text with NO check constraint, deliberately:
-- the whole point is that a new sub-role ships as a line in photo-roles.ts
-- rather than as a migration. Postgres cannot drop an enum value without
-- rebuilding the type, so every idea previously cost a permanent enum entry.
--
-- Two new enum values are genuinely new roles with nowhere to map; every other
-- role in the new vocabulary reuses an existing type plus this column.
--
-- The backfill rewrites the numbered slots onto (type, role). sort_order is
-- untouched, so no gallery reorders and no eBay cover moves.
--
-- ⚠ LISTABILITY: 'measurement' is on NON_LISTABLE_PHOTO_TYPES (the MeasureCard
-- calibration frame is a branded foreign object) but 'measurement_chest' was
-- listable. So the rule becomes role-aware in the same commit: measurement with
-- a NULL role is the card frame and stays non-listable; measurement WITH a role
-- is a tape photo and lists, exactly as measurement_chest did. Without that code
-- change this backfill would silently pull tape photos from live listings.
--
-- Contract + full role vocabulary: vault/20-domain/listing-photos.md

ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'on_hanger';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'set_pair';

ALTER TABLE public.item_photos
  ADD COLUMN IF NOT EXISTS photo_role text;

COMMENT ON COLUMN public.item_photos.photo_role IS
  'Open-text qualifier for photo_type (US-2462). NULL = no qualifier. Vocabulary lives in src/lib/photo-roles.ts, not in a constraint.';

CREATE INDEX IF NOT EXISTS idx_item_photos_type_role
  ON public.item_photos (inventory_item_id, photo_type, photo_role);

-- Backfill. Idempotent: after the first pass no row matches a retired type.
-- The numbered slots get no role because "Detail 3" never meant anything in
-- particular; the measurement slots carry their key across intact.
UPDATE public.item_photos
   SET photo_type = 'tag'
 WHERE photo_type = 'tag_2';

UPDATE public.item_photos
   SET photo_type = 'detail'
 WHERE photo_type IN ('detail_2', 'detail_3', 'detail_4');

UPDATE public.item_photos
   SET photo_type = 'measurement', photo_role = 'chest'
 WHERE photo_type = 'measurement_chest';

UPDATE public.item_photos
   SET photo_type = 'measurement', photo_role = 'waist'
 WHERE photo_type = 'measurement_waist';

UPDATE public.item_photos
   SET photo_type = 'measurement', photo_role = 'length'
 WHERE photo_type = 'measurement_length';

UPDATE public.item_photos
   SET photo_type = 'measurement', photo_role = 'sleeve'
 WHERE photo_type = 'measurement_sleeve';

UPDATE public.item_photos
   SET photo_type = 'measurement', photo_role = 'inseam'
 WHERE photo_type = 'measurement_inseam';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00587') on conflict do nothing;
