-- Product categorization + photo tags (category-driven photo profiles).
--
-- FlipDesk's photo-tagging taxonomy was clothing-only: every seller was asked
-- for front/back/tag/detail regardless of what they were selling. This migration
-- widens BOTH the item_category enum (so jewelry / bags / standalone accessories
-- get a home) and the flipdesk_photo_type enum (adding universal photo "roles"
-- that non-garment items need) so the new server-authoritative photo profiles
-- (services/edge-functions/src/lib/photo-profiles.ts) can map each category to
-- the right set of capture slots.
--
-- NOTE: ALTER TYPE ... ADD VALUE values are NOT used elsewhere in this migration,
-- so they're safe to add inside the migration runner's transaction (PG 12+).

-- ── item_category: new top-level categories ─────────────────────────────────
-- `accessories` = non-garment accessories sold standalone (hats, belts, sunglasses,
-- scarves). Distinct from the clothing garment_type 'accessories'.
ALTER TYPE public.item_category ADD VALUE IF NOT EXISTS 'jewelry'     AFTER 'books';
ALTER TYPE public.item_category ADD VALUE IF NOT EXISTS 'bags'        AFTER 'jewelry';
ALTER TYPE public.item_category ADD VALUE IF NOT EXISTS 'accessories' AFTER 'bags';

-- ── flipdesk_photo_type: universal, reusable photo roles ────────────────────
-- These are the physical storage values. Profiles relabel the generic ones
-- (front/back/detail/tag…) per category and add these for genuinely new roles.
--   angle       3/4 / profile / silhouette view (shoes, electronics, collectibles)
--   sole        shoe outsole / tread
--   marking     hallmark / maker's mark / metal stamp / heat stamp / signature
--   serial      serial / model / reference / date code
--   accessory   included extras: box, papers, dust bag, cables, links
--   certificate grading slab label / certificate of authenticity / COA / appraisal
--   corner      trading-card corner close-up
--   surface     trading-card surface & centering / device screen close-up
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'angle'       AFTER 'on_model';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'sole'        AFTER 'angle';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'marking'     AFTER 'sole';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'serial'      AFTER 'marking';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'accessory'   AFTER 'serial';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'certificate' AFTER 'accessory';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'corner'      AFTER 'certificate';
ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'surface'     AFTER 'corner';
