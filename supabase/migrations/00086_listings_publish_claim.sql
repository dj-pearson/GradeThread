-- US-528: idempotent scheduled publishing.
--
-- The publish-due cron (edge flipdesk-ebay.ts POST /jobs/publish-due) runs every
-- 5 minutes and selected drafts purely by (listing_status='draft' AND
-- synced_to_ebay_at IS NULL AND scheduled_publish_at <= now). A publish that
-- takes longer than the cron interval (eBay latency + retries) was therefore
-- still 'draft' on the next tick and got published a SECOND time -> duplicate
-- live listing.
--
-- This adds a claim timestamp so the cron can atomically claim each due draft
-- before publishing it (UPDATE ... SET publish_claimed_at=now WHERE id=? AND
-- listing_status='draft' AND synced_to_ebay_at IS NULL AND the claim is null or
-- stale). Only the tick that wins the row-level update proceeds; concurrent
-- ticks see a fresh claim and skip. Stale claims (older than the reclaim window
-- enforced in code) become eligible again, so a crashed/redeployed publish does
-- not strand the draft forever.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS publish_claimed_at timestamptz;

COMMENT ON COLUMN public.listings.publish_claimed_at IS
  'US-528: when the publish-due cron last claimed this draft for publishing. Used as an atomic claim lock (with a code-side stale-reclaim window) so a slow publish is not double-published by the next cron tick.';

-- Supports the publish-due scan: due + still-draft + not-yet-live drafts,
-- ordered/filtered by scheduled_publish_at. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_listings_publish_due
  ON public.listings (scheduled_publish_at)
  WHERE listing_status = 'draft' AND synced_to_ebay_at IS NULL;
