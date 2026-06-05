-- ============================================================================
-- GradeThread / FlipDesk — inventory cleanup for duplicate & placeholder items
-- Generated 2026-06-04 from your export. Scoped to YOUR user only.
--
-- HOW TO RUN (Supabase SQL editor, https://api.gradethread.com → SQL):
--   1. Run STEP 1 and STEP 3 (SELECTs) first and eyeball the rows.
--   2. Only if they look right, run STEP 2 (the DELETE).
--   3. STEP 4 is a REVIEW list — decide for yourself, nothing is deleted.
--
-- Everything is filtered to user_id = c55c2414-... so it can never touch
-- another account. Deleting an inventory_item cascades to its photos/listings
-- if the foreign keys are ON DELETE CASCADE; if you get an FK error instead,
-- tell me and I'll add the dependent-row deletes.
-- ============================================================================

-- ── STEP 1 — PREVIEW the junk to be deleted ────────────────────────────────
-- (a) Abandoned AutoLister placeholders: literally titled "Item N" / "Untitled
--     item", never given a SKU, still mid-pipeline. 6 expected.
-- (b) The Rag & Bone Polo duplicate: a no-SKU "measured" draft that duplicates
--     the real listed copy (SKU 645). 1 expected.
SELECT id, sku, status, created_at, title
FROM public.inventory_items
WHERE user_id = 'c55c2414-7e0b-4431-944e-c0a16887bf31'
  AND sku IS NULL
  AND status IN ('cataloged','photographed','drafted','measured')
  AND (
    title ~* '^(item\s+\d+|untitled item)\s*$'                       -- placeholders
    OR (title ILIKE 'Rag & Bone Polo Shirt Men''s M Large Slim Fit%'  -- the dup draft
        AND status = 'measured')
  )
ORDER BY title, created_at;

-- ── STEP 2 — DELETE the junk (run ONLY after STEP 1 looks correct) ──────────
-- Same WHERE as the preview. Expect "DELETE 7" (6 placeholders + 1 Rag & Bone
-- draft). The Supabase editor commits each run, so this is final once you click
-- Run — that's why STEP 1 exists. To be extra-safe you can run it inside a
-- transaction block (BEGIN; <delete>; … then COMMIT; or ROLLBACK;).
DELETE FROM public.inventory_items
WHERE user_id = 'c55c2414-7e0b-4431-944e-c0a16887bf31'
  AND sku IS NULL
  AND status IN ('cataloged','photographed','drafted','measured')
  AND (
    title ~* '^(item\s+\d+|untitled item)\s*$'
    OR (title ILIKE 'Rag & Bone Polo Shirt Men''s M Large Slim Fit%'
        AND status = 'measured')
  );

-- ── STEP 3 — Verify the placeholders are gone ──────────────────────────────
SELECT count(*) AS remaining_placeholders
FROM public.inventory_items
WHERE user_id = 'c55c2414-7e0b-4431-944e-c0a16887bf31'
  AND title ~* '^(item\s+\d+|untitled item)\s*$';

-- ── STEP 4 — REVIEW (NOT deleted — your call) ──────────────────────────────
-- These share a title but each has its OWN SKU, so they may be separate
-- physical pieces from a lot rather than duplicates. Decide per row; to remove
-- one, delete it by id:  DELETE FROM public.inventory_items WHERE id = '...';
--
--   ADIDAS mens medium track jacket Sandstone  → SKUs 252, 253, 254
--   Anthropologie Maeve The Colette … (exact-title pair) → SKUs 614, 618
SELECT id, sku, status, created_at, title
FROM public.inventory_items
WHERE user_id = 'c55c2414-7e0b-4431-944e-c0a16887bf31'
  AND (
    title ILIKE 'ADIDAS mens medium track jacket Sandstone%'
    OR title ILIKE 'Anthropologie Maeve The Colette Women''s Wide Leg Pants%'
  )
ORDER BY title, sku;
