-- US-2566: provenance for derived evidence assets.
--
-- lib/defect-annotations.ts renders annotated defect photos and inserts them
-- into item_photos with photo_type 'defect' and nothing else. The entire lineage
-- lives in the FILENAME — `{ownerId}/{itemId}/disclosure_auto_{type}_{reportTag}.jpg` —
-- and staleness after a regrade is detected by substring matching on
-- storage_path (`includes('/disclosure_auto_')` plus a `_{reportTag}.jpg` suffix test).
--
-- That works for "is this stale" and for nothing else. It cannot answer which
-- defect a crop shows, which source photo it was rendered from, which
-- certificate it belongs to, or what transform produced it. A returns-defense
-- artifact that cannot state its own provenance in SQL is not evidence, it is a
-- picture — and the filename scheme also COLLIDES the moment a second crop is
-- rendered from the same source image, which is exactly what per-defect zoom
-- crops (US-2567) need to do.
--
-- Every column is nullable. An existing row is a seller-uploaded photo with no
-- derivation, and that is a correct NULL rather than a backfill gap. The
-- derived rows written before this migration are identifiable by their
-- `disclosure_auto_` path prefix and are re-derived on the next annotation pass, so no
-- backfill is attempted here.

ALTER TABLE public.item_photos
  -- The report this asset documents. Also the join a regrade prunes on, which
  -- replaces the `_{reportTag}.jpg` suffix match. ON DELETE SET NULL rather than
  -- CASCADE: a deleted report should orphan the asset for cleanup, not silently
  -- remove imagery a live listing is pointing at.
  ADD COLUMN IF NOT EXISTS derived_from_grade_report_id uuid
    REFERENCES public.grade_reports(id) ON DELETE SET NULL,
  -- The private-bucket object this was rendered from
  -- (submission_images.storage_path).
  ADD COLUMN IF NOT EXISTS derived_from_storage_path text,
  ADD COLUMN IF NOT EXISTS derived_transform text
    CHECK (derived_transform IS NULL OR derived_transform IN (
      'annotated_full',    -- callouts + legend over the whole photo (today)
      'defect_crop',       -- one defect, zoomed (US-2567)
      'certificate_card'   -- the cert-stamped summary card (US-2567)
    )),
  -- The defect this asset documents, by its CALLOUT NUMBER — the 1-based `n`
  -- that buildDisclosure assigns and that is printed on the image itself. That
  -- is deliberately the number a buyer or a marketplace claim form would cite,
  -- rather than a position in grade_reports.defects_found, which is a different
  -- list nobody outside the pipeline ever sees. NULL for annotated_full (covers
  -- every defect on its source) and for certificate_card (covers none).
  ADD COLUMN IF NOT EXISTS derived_defect_index integer,
  -- The normalized [x, y, w, h] this asset was boxed or cropped to, so a crop
  -- can be re-derived from the source or disputed against it.
  ADD COLUMN IF NOT EXISTS derived_bbox jsonb,
  -- Denormalized deliberately: an evidence artifact has to be readable without
  -- a join, including after its report is superseded by a regrade.
  ADD COLUMN IF NOT EXISTS certificate_number text;

COMMENT ON COLUMN public.item_photos.derived_from_grade_report_id IS
  'US-2566: the grade report this derived asset documents. NULL for '
  'seller-uploaded photos. Replaces the disclosure_auto_ filename convention as the '
  'staleness key — a regrade deletes derived rows whose report id is not the '
  'current one.';
COMMENT ON COLUMN public.item_photos.derived_from_storage_path IS
  'US-2566: the submission-images object this was rendered from. The private '
  'source of a public derivative.';
COMMENT ON COLUMN public.item_photos.derived_transform IS
  'US-2566: what was done to the source. annotated_full | defect_crop | '
  'certificate_card.';
COMMENT ON COLUMN public.item_photos.derived_defect_index IS
  'US-2566: the defect callout NUMBER printed on this asset (the 1-based n from '
  'buildDisclosure), not a position in grade_reports.defects_found. NULL when '
  'the asset covers every defect on its source image, or none.';
COMMENT ON COLUMN public.item_photos.certificate_number IS
  'US-2566: the GT-XXXXXXX this asset was rendered under, denormalized so the '
  'artifact stands alone.';

-- Replaces the filename-substring idempotency check in
-- applyAutoDefectAnnotations. Partial, so the seller-uploaded rows — the vast
-- majority — carry no index entry at all. COALESCE on the defect index because
-- NULLs never collide in a unique index, and "one annotated_full per source per
-- report" is exactly the constraint that must hold.
CREATE UNIQUE INDEX IF NOT EXISTS item_photos_derived_identity_idx
  ON public.item_photos (
    inventory_item_id,
    derived_from_grade_report_id,
    derived_transform,
    derived_from_storage_path,
    (COALESCE(derived_defect_index, -1))
  )
  WHERE derived_from_grade_report_id IS NOT NULL;

-- The prune query a regrade runs: every derived asset for this item that is NOT
-- from the current report.
CREATE INDEX IF NOT EXISTS item_photos_derived_report_idx
  ON public.item_photos (inventory_item_id, derived_from_grade_report_id)
  WHERE derived_from_grade_report_id IS NOT NULL;

-- US-1108: self-record so the edge schema-version boot guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00598') ON CONFLICT DO NOTHING;
