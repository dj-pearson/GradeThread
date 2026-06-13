-- US-717: extension auto-delist queue.
--
-- When a cross-listed item sells, the other siblings must be ended so the same
-- garment isn't sold twice. API marketplaces (eBay/Shopify/Depop) are ended
-- server-side by calling their delist API. The extension marketplaces
-- (Poshmark/Mercari/Grailed) have NO write API and run only in the seller's own
-- browser via the GradeThread Lister extension (US-716) — the server can't reach
-- them. So instead of pretending we delisted them, auto-end QUEUES the work:
-- it stamps `delist_requested_at` on the extension sibling, and the next time
-- the seller is in GradeThread the Lister extension ends the listing in their
-- own tab, then the writeback clears the stamp.
--
-- Nullable — only extension siblings awaiting a manual/extension delist carry a
-- value; everything else stays null. No backfill needed.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS delist_requested_at timestamptz;

COMMENT ON COLUMN public.listings.delist_requested_at IS
  'US-717: set when a cross-listing sale auto-ends an extension sibling (Poshmark/Mercari/Grailed) that has no delist API. Cleared once the GradeThread Lister extension ends the listing in the seller''s own browser. NULL for API marketplaces and listings with nothing pending.';

-- Partial index so the pending-delist queue lookup (the extension surface polls
-- "what still needs ending?") stays cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_listings_delist_requested
  ON public.listings(delist_requested_at)
  WHERE delist_requested_at IS NOT NULL;
