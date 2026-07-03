-- US-1577: 'measurement_overlay' photo type — the GENERATED, card-free,
-- unbranded annotated measurements photo (lines + inch labels burned in)
-- rendered from a calibrated MeasureCard shot. Unlike 'measurement' (the raw
-- card frame, never listed), the overlay IS listing-eligible: it ships to
-- eBay as a non-primary gallery photo. It is never auto-primary (cover pick
-- excludes it) and regenerating after a measurement edit replaces the prior
-- render. Enforcement is code-side (lib/item-photo-storage.ts + the cover
-- pick in ai-listing.ts), same model as 'internal'/'measurement'.
--
-- Enum caveat: the new value can't be USED in the same transaction that adds
-- it; the edge only writes it post-deploy (boot guard holds the edge behind
-- this migration via EXPECTED_SCHEMA_VERSION 00350).

ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement_overlay';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00350') on conflict do nothing;
