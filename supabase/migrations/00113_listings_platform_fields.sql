-- 00113_listings_platform_fields.sql
--
-- US-721: store AI-generated, per-marketplace listing fields so one item can be
-- cross-listed to platforms with different requirements (title length, tone,
-- tags, condition wording, category) without rebuilding the listing per place.
--
-- The eBay draft keeps its dedicated columns (listing_title, ebay_condition,
-- item_specifics_override, …). Every OTHER platform's tailored fields live in
-- this jsonb blob keyed by listing_platform, e.g.:
--   {
--     "poshmark": { "title": "...", "description": "...",
--                   "condition": {"value":"EUC","label":"EUC (Excellent Used Condition)"},
--                   "category": "Women > Tops", "brand": "...", "color": "...",
--                   "size": "M", "price": 28, "tags": ["#vintage"],
--                   "confidence": 0.82,
--                   "validation": {"ok": true, "issues": []},
--                   "generated_at": "2026-06-08T..." },
--     "mercari": { ... }
--   }
-- The copy-paste Listing Kit (US-723), photo export (US-724), and pre-flight
-- validation (US-725) read from here. Shape is intentionally schema-light (jsonb)
-- so adding a platform field never needs a migration. Idempotent.

BEGIN;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS platform_fields jsonb,
  ADD COLUMN IF NOT EXISTS platform_fields_generated_at timestamptz;

COMMENT ON COLUMN public.listings.platform_fields IS
  'US-721: AI-generated per-marketplace listing fields, keyed by listing_platform '
  '(poshmark/mercari/depop/grailed/shopify). eBay keeps its dedicated columns. '
  'Read by the copy-paste Listing Kit, photo export, and pre-flight validation.';

COMMIT;
