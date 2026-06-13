-- US-825: Aspect provenance — record WHERE each eBay item-specific came from
-- (AI extraction, deterministic inventory derivation, or a manual edit) so the
-- composer / iOS editor can badge sources and show a pre-publish required-aspect
-- checklist BEFORE publish, instead of only surfacing gaps as publish-time
-- blockers from assemblePublishContext.
--
-- SCHEMA DECISION (documented per acceptance criteria): provenance is stored as
-- a PARALLEL jsonb map keyed by aspect name — `{ "<aspectName>": "<source>" }`
-- where source ∈ ('ai_extracted','inventory_derived','manual'). It sits ALONGSIDE
-- the existing aspect-value maps (inventory_items.ebay_aspects and
-- listings.item_specifics_override) rather than reshaping those into
-- per-aspect objects, because:
--   • the value maps are read in many hot paths (publish offer build, prefill,
--     comps) that must keep their `Record<string,string[]>` shape untouched;
--   • a parallel map is additive and back-compatible — a missing key just means
--     "source unknown" (treated as manual/unknown), so existing rows need no
--     backfill;
--   • the fourth provenance state, `unfilled`, is COMPUTED (an aspect in the
--     category spec with no value) and never stored.
-- The two maps mirror the two value stores: item_specifics_sources is parallel
-- to listings.item_specifics_override (the per-listing canonical copy publish
-- reads first); ebay_aspect_sources is parallel to inventory_items.ebay_aspects
-- (the inventory mirror / legacy fallback).

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS ebay_aspect_sources jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS item_specifics_sources jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN inventory_items.ebay_aspect_sources IS
  'US-825: per-aspect provenance parallel to ebay_aspects — { aspectName: ai_extracted|inventory_derived|manual }.';
COMMENT ON COLUMN listings.item_specifics_sources IS
  'US-825: per-aspect provenance parallel to item_specifics_override — { aspectName: ai_extracted|inventory_derived|manual }.';
