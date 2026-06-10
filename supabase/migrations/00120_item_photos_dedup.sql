-- Fix the iOS duplicate-photo bug + guard against recurrence.
--
-- Root cause: when a photo upload's DB write got a lost/timed-out response
-- (after the server had already committed), the iOS client enqueued a retry
-- with a BRAND-NEW client id and upserted it. That second id meant the same
-- storage_path landed in item_photos twice; the sync pull then mirrored both
-- rows to the app, web, and eBay. The client now shares ONE deterministic id
-- across the insert and the retry (idempotent). This migration:
--   1. Repoints any listing cover at a duplicate to its surviving twin.
--   2. Deletes the duplicate rows (one survivor per item + storage_path).
--   3. Adds a partial unique index so a duplicate can never be inserted again.
--
-- Survivor pick per (inventory_item_id, storage_path): a photo used for grading
-- wins (keeps the grade's photo linkage), then the earliest created, then the
-- smallest id for determinism. storage_path is NULL only for rows we never
-- want to dedupe on, so the whole pass is scoped to NOT NULL paths.

BEGIN;

-- 1) Repoint listings.primary_photo_id from a doomed duplicate to the keeper,
--    so we don't blank a user's chosen cover when the duplicate is deleted.
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY inventory_item_id, storage_path
      ORDER BY used_for_grading DESC, created_at ASC, id ASC
    ) AS keeper_id,
    row_number() OVER (
      PARTITION BY inventory_item_id, storage_path
      ORDER BY used_for_grading DESC, created_at ASC, id ASC
    ) AS rn
  FROM public.item_photos
  WHERE storage_path IS NOT NULL
),
dupes AS (
  SELECT id AS dup_id, keeper_id FROM ranked WHERE rn > 1
)
UPDATE public.listings l
SET primary_photo_id = d.keeper_id
FROM dupes d
WHERE l.primary_photo_id = d.dup_id;

-- 2) Delete the duplicates, keeping each group's survivor.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY inventory_item_id, storage_path
      ORDER BY used_for_grading DESC, created_at ASC, id ASC
    ) AS rn
  FROM public.item_photos
  WHERE storage_path IS NOT NULL
)
DELETE FROM public.item_photos p
USING ranked r
WHERE p.id = r.id AND r.rn > 1;

-- 3) Guard: one photo row per item + storage path. Partial so any legacy rows
--    with a NULL storage_path are unaffected. A retry now upserts on the PK
--    (same id), so it updates in place rather than tripping this index.
CREATE UNIQUE INDEX IF NOT EXISTS item_photos_item_storage_path_uniq
  ON public.item_photos (inventory_item_id, storage_path)
  WHERE storage_path IS NOT NULL;

COMMIT;
