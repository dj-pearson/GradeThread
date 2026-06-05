-- Photo-type taxonomy v3.
--
-- Adds richer photo classification to BOTH photo-type enums so sellers can
-- attach multiple tag shots, multiple detail shots, and (critically) flat
-- measurement photos for garments with no/illegible size tag — e.g. used
-- Lululemon, where the size is a hidden dot and buyers grade by measurements.
--
-- Two parallel enums (kept deliberately separate):
--   public.image_type          — core grading submissions (submission_images)
--   public.flipdesk_photo_type — FlipDesk listing/catalog photos (item_photos)
--
-- ALTER TYPE ... ADD VALUE is idempotent here (IF NOT EXISTS) and ordered with
-- AFTER so the enum reads logically. New values are append-only — existing rows
-- are untouched and no value is consumed in this same transaction.

-- ── Grading enum (image_type): front, back, label, detail, defect ──────────
-- A second tag/label shot (e.g. brand tag + separate size/care tag).
ALTER TYPE public.image_type ADD VALUE IF NOT EXISTS 'label_2' AFTER 'label';
-- Additional close-up detail slots.
ALTER TYPE public.image_type ADD VALUE IF NOT EXISTS 'detail_2' AFTER 'detail';
ALTER TYPE public.image_type ADD VALUE IF NOT EXISTS 'detail_3' AFTER 'detail_2';
ALTER TYPE public.image_type ADD VALUE IF NOT EXISTS 'detail_4' AFTER 'detail_3';
-- Flat-measurement shots (tape measure across the garment) for size ID when no
-- size tag exists. Distinct points so each shot maps to a known dimension.
ALTER TYPE public.image_type ADD VALUE IF NOT EXISTS 'measurement_chest'  AFTER 'defect';
ALTER TYPE public.image_type ADD VALUE IF NOT EXISTS 'measurement_waist'  AFTER 'measurement_chest';
ALTER TYPE public.image_type ADD VALUE IF NOT EXISTS 'measurement_length' AFTER 'measurement_waist';
ALTER TYPE public.image_type ADD VALUE IF NOT EXISTS 'measurement_sleeve' AFTER 'measurement_length';
ALTER TYPE public.image_type ADD VALUE IF NOT EXISTS 'measurement_inseam' AFTER 'measurement_sleeve';

-- ── FlipDesk enum (flipdesk_photo_type): front, back, tag, detail, detail_2,
--    detail_3, interior, defect, flatlay, on_model ───────────────────────────
-- A second tag shot.
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'tag_2' AFTER 'tag';
-- Fourth detail slot (detail_2/detail_3 already exist).
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'detail_4' AFTER 'detail_3';
-- Flat-measurement shots, mirroring the grading enum.
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement_chest'  AFTER 'on_model';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement_waist'  AFTER 'measurement_chest';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement_length' AFTER 'measurement_waist';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement_sleeve' AFTER 'measurement_length';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement_inseam' AFTER 'measurement_sleeve';
