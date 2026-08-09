-- US-2223 AC6 + US-2224 AC3: the taxonomy values three new rubrics need.
--
-- ONE MIGRATION FOR TWO STORIES, deliberately. Both widen the SAME taxonomy for
-- the same reason — a rubric keyed on a category value that does not exist can
-- never be selected — and splitting them across two files would mean two apply
-- steps, two rollbacks and two chances to apply one without the other.
--
-- ── WHAT WAS ALREADY THERE, AND WHAT WAS NOT ────────────────────────────────
-- garment_category (00001) has carried 'hat', 'bag', 'belt' and 'scarf' since
-- the beginning and has never been widened. So headwear and small leather goods
-- were REPRESENTABLE; neckwear and gloves were not — a tie had no value to be,
-- which is why US-2224 describes them as "not even representable".
--
-- item_category (00230) gained jewelry / bags / accessories but no headwear, so
-- the US-2223 rubric and photo profile — both keyed by item_category — could
-- never be selected. That is the gap rubric-parity_test.ts now guards against,
-- and this closes it from the other side.

-- ── item_category: headwear gets its own top level ──────────────────────────
--
-- NOT folded into 'accessories'. A cap's condition lives in the crown, the brim
-- and the sweatband; an accessory's lives in its material, its edges and its
-- hardware. Those are different rubrics with different photo slots and
-- different measurements, and item_category is exactly the dimension that
-- chooses between them. Filing headwear under accessories would have made the
-- headwear rubric unreachable while looking correct.
--
-- AFTER 'accessories' so the picker's order stays sensible; enum position is
-- display order for anything that reads the type's value list.
ALTER TYPE public.item_category ADD VALUE IF NOT EXISTS 'headwear' AFTER 'accessories';

-- ── garment_category: the two shapes that had nowhere to go ─────────────────
--
-- 'neckwear' rather than 'tie', because the same rubric grades a bow tie, an
-- ascot and a cravat, and a value named for one of them invites a seller to
-- pick 'other' for the rest — which routes them straight back into the clothing
-- rubric this work exists to get them out of.
ALTER TYPE public.garment_category ADD VALUE IF NOT EXISTS 'neckwear' AFTER 'scarf';
-- Plural, matching the physical object. A single glove is a loss, not a listing.
ALTER TYPE public.garment_category ADD VALUE IF NOT EXISTS 'gloves' AFTER 'neckwear';

-- ⚠ NO TRANSACTION WRAPPER, and that is not an oversight. Postgres refuses to
-- USE a new enum value in the same transaction that adds it. Nothing here uses
-- one — these are three bare ADD VALUEs — but wrapping them would make this
-- file unsafe to extend: the next person appending an UPDATE that sets a row to
-- 'headwear' would get a runtime error that reads as a Postgres quirk rather
-- than as their own edit. Leaving it unwrapped keeps that door shut.
--
-- ADD VALUE IF NOT EXISTS is idempotent on Postgres 12+, so re-running the
-- whole directory (scripts/apply-prod-migrations.sh does exactly that) is safe.

COMMENT ON TYPE public.item_category IS
  'US-2223: top-level product category. Chooses the grading rubric, the photo profile and the measurement template — see services/edge-functions/src/lib/rubric.ts, photo-profiles.ts and measurement-templates.ts. A rubric keyed on a value absent here can never be selected.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00570') on conflict do nothing;
