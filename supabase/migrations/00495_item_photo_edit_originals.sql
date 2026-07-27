-- US-2208: non-destructive editing for listing photos.
--
-- The photo editor writes its output back over item_photos.storage_path, so a
-- saved brightness or crop could never be undone and the pristine upload was
-- gone for good. Two additive columns fix that:
--
--   original_storage_path — the untouched original, copied aside ONCE, the
--     first time an edit is saved for that photo. NULL means the photo has
--     never been edited and the object at storage_path IS the original.
--
--   edit_recipe — the geometry + tone that produced the current image
--     (rotation, straighten, crop, the five tone sliders, whether a background
--     cut-out was applied). It lets the editor reopen from the ORIGINAL with
--     the sliders where the seller left them, rather than re-encoding an
--     already-lossy JPEG on every pass and compounding tone on top of tone.
--
-- Both are nullable and default NULL, so every existing row keeps working with
-- no backfill: an un-edited photo is exactly the "never edited" case.

alter table public.item_photos
  add column if not exists original_storage_path text,
  add column if not exists edit_recipe jsonb;

comment on column public.item_photos.original_storage_path is
  'Storage path of the pristine pre-edit original, set once on first edit. NULL = never edited; storage_path is the original.';

comment on column public.item_photos.edit_recipe is
  'US-2208 edit recipe {v, rotation, fine, crop, aspect, adjustments, bgRemoved} describing how the current image was derived from the original. NULL = unedited.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00495') on conflict do nothing;
