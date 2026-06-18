-- US-1061: one-time, dismissable "manage this item in FlipDesk" disclaimer
-- shown the first time a user successfully publishes a listing to eBay.
--
-- Because of how the eBay API sync works, ongoing management of a published
-- item (images, price, details, end/relist) must happen in FlipDesk —
-- editing directly on eBay can desync or be overwritten. We surface that once
-- on the first successful publish and persist the dismissed state per user so
-- the notice never shows again and survives a device change.
--
-- Mirrors the existing `dismissed_flipdesk_promo` flag (00029): a simple
-- boolean on the users row, RLS-scoped to the owner for self-update.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS dismissed_ebay_publish_disclaimer boolean NOT NULL DEFAULT false;
