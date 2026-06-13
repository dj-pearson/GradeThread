-- US-766: auto-attach the Digital Slab (US-763) to marketplace listings.
--
-- The slab is the PSA-style, QR-bearing "graded photo" served at
-- /slab/cert/:id (functions/slab/cert/[id].ts). This lets a seller ride the
-- grade + scannable certificate QR onto the marketplace thumbnail itself —
-- "PSA-on-the-listing" — by including it as either the LEAD image or a
-- SUPPLEMENTARY image at publish.
--
-- Two knobs, mirroring the grade-badge promotion (00027 + 00145):
--   * listings.slab_image_mode — per-listing opt-in + hero/extra choice. The
--     seller picks this in the composer (US-118). 'off' | 'hero' | 'extra'.
--   * flipdesk_settings.auto_slab_image — per-user GLOBAL default. When on and
--     a listing is still at 'off', the slab is included as a supplementary
--     ('extra') image. An explicit per-listing 'hero'/'extra' always wins.
--
-- The burn/inject happens server-side at publish (applySlabImagePromotion in
-- flipdesk-ebay.ts) so it reaches EVERY publish path (manual, AutoLister,
-- scheduled, bulk), and only when the item is graded with a public certificate.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS guards re-runs (the inline CHECK rides
-- along only on first creation, exactly like the column).

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS slab_image_mode text NOT NULL DEFAULT 'off'
    CHECK (slab_image_mode IN ('off', 'hero', 'extra'));

ALTER TABLE public.flipdesk_settings
  ADD COLUMN IF NOT EXISTS auto_slab_image boolean NOT NULL DEFAULT false;
