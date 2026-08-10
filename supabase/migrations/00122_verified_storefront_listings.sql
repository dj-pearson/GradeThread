-- Verified storefront — opt-in to list active listings on the public profile.
--
-- The public /verified/:handle page already aggregates a seller's CERTIFIED
-- grades. This flag lets a seller additionally turn that page into a shop: when
-- verified_show_listings is true (AND the profile is verified_enabled), the
-- public sellers endpoint also returns the seller's ACTIVE listings — graded
-- items linking to their certificate, non-graded items linking out to the
-- marketplace. It is a SEPARATE opt-in from verified_enabled so a seller who
-- only wants a trust profile never exposes their inventory/prices.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS verified_show_listings boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.verified_show_listings IS
  'Verified storefront opt-in: when true (and verified_enabled), the public '
  '/verified/:handle page lists the seller''s active listings (graded → cert, '
  'non-graded → marketplace URL). Default false.';
