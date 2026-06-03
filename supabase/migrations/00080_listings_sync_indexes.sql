-- US-409: composite + partial indexes for the hottest FlipDesk sync queries.
--
-- Before this, listings only had single-column indexes (00002:
-- idx_listings_inventory_item_id, idx_listings_platform) plus the autolister
-- scheduled-publish index (00052). The sync's per-row lookups and the
-- scheduled-publish scan therefore filtered on one column then sorted/scanned.

-- 1) Per-item listing lookup, newest first.
--    The eBay sync resolves the local listing(s) for an inventory item on a
--    given platform, most-recent first. A composite on
--    (inventory_item_id, platform, created_at DESC) serves the equality filter
--    AND the ORDER BY created_at DESC directly from the index — no sort, no
--    heap scan for the ordering. (Supersedes idx_listings_inventory_item_id for
--    this access path; that single-column index is left in place as it is cheap
--    and other equality-only lookups still use it.)
CREATE INDEX IF NOT EXISTS idx_listings_item_platform_created
  ON public.listings (inventory_item_id, platform, created_at DESC);

-- 2) Scheduled-publish "due" scan (/api/flipdesk/ebay/jobs/publish-due, US-322).
--    The worker selects rows where:
--      scheduled_publish_at <= now()
--      AND synced_to_ebay_at IS NULL
--      AND listing_status = 'draft'
--    The existing idx_listings_scheduled_publish_at (00052) omits the
--    listing_status='draft' predicate, so it still matched already-published or
--    non-draft rows. This partial index is narrowed to exactly the due-draft
--    set and ordered by the range column, so the scan touches only candidates.
CREATE INDEX IF NOT EXISTS idx_listings_publish_due
  ON public.listings (scheduled_publish_at)
  WHERE synced_to_ebay_at IS NULL AND listing_status = 'draft';

-- Verify post-deploy:
--   EXPLAIN ANALYZE
--     SELECT id, inventory_item_id FROM public.listings
--     WHERE inventory_item_id = $1 AND platform = 'ebay'
--     ORDER BY created_at DESC;
--   -> Index Scan using idx_listings_item_platform_created (no Sort node).
--
--   EXPLAIN ANALYZE
--     SELECT id, inventory_item_id FROM public.listings
--     WHERE scheduled_publish_at <= now()
--       AND synced_to_ebay_at IS NULL AND listing_status = 'draft'
--     LIMIT 100;
--   -> Index Scan using idx_listings_publish_due.
