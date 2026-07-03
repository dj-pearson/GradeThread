-- US-1571: MeasureCard "measurement" photo type.
--
-- The photo-measurement pipeline (US-1570..1580) keys on ONE dedicated shot:
-- the garment laid flat with the GradeThread MeasureCard (four ArUco
-- fiducials) beside it. Tagging it 'measurement' is what tells the
-- calibration/extraction services which photo to read. 'measurement' photos:
--   • stay on the item and render in-app (photo managers, canvas, the
--     measurement overlay editor),
--   • are NEVER sent to eBay / cross-listings and never appear on public
--     surfaces (the card is a branded foreign object in a listing photo) —
--     same code-side enforcement as 'internal'
--     (lib/item-photo-storage.ts filterListablePhotos),
--   • are EXCLUDED from the generation/classify AI passes (the measurement
--     extract pass queries the photo explicitly by type instead), and
--   • do NOT count toward the required photo set (front+back stands;
--     items_full.has_required_photos already counts only front/back).
-- Distinct from the existing measurement_* close-up types (tape-measure shots
-- for size estimation): 'measurement' is the whole-garment calibration frame.
--
-- NOTE (enum caveat): the new value cannot be USED in the same transaction
-- that adds it; edge code only ever compares photo_type strings in JS, so
-- nothing filters on 'measurement' SQL-side before this applies.

ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00346') on conflict do nothing;
