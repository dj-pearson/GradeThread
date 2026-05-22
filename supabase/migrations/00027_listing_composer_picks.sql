-- Listing composer variants + preview (US-118): persist the reseller's
-- photo and badge picks on the listings row so a saved draft remembers
-- which photo is primary and whether a GradeThread grade badge should be
-- composited onto it before the listing is pushed to eBay.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS primary_photo_id uuid
    REFERENCES public.item_photos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS badge_enabled boolean NOT NULL DEFAULT false;
