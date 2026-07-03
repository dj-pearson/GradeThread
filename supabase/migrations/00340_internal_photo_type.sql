-- US-1549: seller-reference "internal" photo type.
--
-- Resellers photograph things they want to KEEP with the item but never
-- publish — the price tag showing what they paid, a receipt corner, a
-- sourcing note. Today those shots either pollute the eBay gallery / AI
-- inputs (as 'detail') or don't get taken at all. 'internal' photos:
--   • stay on the item and render in-app (photo managers, canvas),
--   • are NEVER sent to eBay (publish/revise/relist photo assembly filters
--     them — lib/item-photo-storage.ts filterListablePhotos),
--   • are NEVER fed to AI passes (listing generation, AutoLister
--     classify/verify), and
--   • never appear on public surfaces (storefront).
-- Enforcement lives edge-side in code (not the DB), so the blob itself stays
-- wherever it was uploaded; the filters read photo_type.

ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'internal';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00340') on conflict do nothing;
