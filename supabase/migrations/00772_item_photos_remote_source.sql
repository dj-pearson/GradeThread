-- US-3196: photos a synced eBay listing brought with it, referenced not stored.
--
-- The eBay pull sync already mirrors a listing's title, price, category and item
-- specifics onto the FlipDesk item. It has never mirrored the pictures, so a
-- seller who syncs 400 active listings gets 400 rows with no imagery and a
-- catalog that does not look like the one they left on eBay.
--
-- Copying the bytes would fix the look and cost storage on every image the
-- seller will never touch. eBay's EPS CDN serves those images publicly and our
-- CSP already allows *.ebayimg.com, so the sync writes a REFERENCE row instead:
-- photo_url is eBay's URL, storage_path stays NULL, and remote_source says the
-- NULL is deliberate rather than a half-finished upload.
--
-- WHY A SECOND COLUMN FOR THE URL. remote_source_url survives the copy. When a
-- seller adopts a reference photo, storage_path and photo_url become ours and
-- the eBay URL would otherwise be lost — and the next sync, seeing no row
-- carrying that URL, would insert the same picture a second time. It is the
-- dedupe key, so it must outlive the value it started as.
--
-- WHAT A NULL storage_path COSTS. A referenced photo cannot be cropped, tone
-- matched or sent back to eBay on a publish, and it disappears if the seller
-- ends the listing and eBay purges the file. That is the trade the adopt action
-- exists to reverse, one item at a time.
--
-- DEPLOY ORDER: database first. The edge writes remote_source during a sync and
-- the frontend reads it on the photo grid, so the schema-version boot guard
-- carries it — EXPECTED_SCHEMA_VERSION moves to 00772 in this same commit.

ALTER TABLE public.item_photos
  ADD COLUMN IF NOT EXISTS remote_source text,
  ADD COLUMN IF NOT EXISTS remote_source_url text;

COMMENT ON COLUMN public.item_photos.remote_source IS
  'US-3196: the marketplace hosting this photo when storage_path is NULL. NULL means GradeThread owns the file (or it is still uploading). Today only ''ebay''.';

COMMENT ON COLUMN public.item_photos.remote_source_url IS
  'US-3196: the marketplace URL this photo came from. Kept AFTER the seller copies the image into our bucket, so a later sync recognises the picture and does not add it twice.';

-- Constrained rather than open text: the value gates behaviour (the outbound
-- publish path skips these rows), so a typo would silently list a photo eBay
-- rejects. A new marketplace costs one line here and that is the intent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'item_photos_remote_source_known'
  ) THEN
    ALTER TABLE public.item_photos
      ADD CONSTRAINT item_photos_remote_source_known
      CHECK (remote_source IS NULL OR remote_source IN ('ebay'));
  END IF;
END $$;

-- The sync's dedupe read: "does this item already carry this eBay picture?"
-- Partial, because the overwhelming majority of item_photos rows are ordinary
-- uploads with no remote origin at all.
CREATE INDEX IF NOT EXISTS idx_item_photos_remote_source_url
  ON public.item_photos (inventory_item_id, remote_source_url)
  WHERE remote_source_url IS NOT NULL;

-- Picture URLs for an eBay listing that matched no FlipDesk SKU. They sit here
-- until the seller links the orphan or turns it into a new item, at which point
-- they become item_photos reference rows.
ALTER TABLE public.flipdesk_ebay_listings
  ADD COLUMN IF NOT EXISTS photo_urls text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.flipdesk_ebay_listings.photo_urls IS
  'US-3196: eBay-hosted picture URLs for this unmatched listing, in eBay''s order. Copied onto item_photos as reference rows when the orphan becomes an inventory item.';

insert into public.applied_migrations (version) values ('00772') on conflict do nothing;
