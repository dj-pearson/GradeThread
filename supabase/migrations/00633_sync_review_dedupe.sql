-- US-2717: stop the sold-sync review queue re-inserting the same unmatched sale.
--
-- 00632 added `marketplace_sync_reviews_open_uniq`, whose comment says exactly
-- why it exists: "a poll every 30 minutes re-observes the same unexplained
-- absence forever, and without this the seller opens the queue to forty copies
-- of one problem." That index is partial on `listing_id IS NOT NULL`, and an
-- UNMATCHED sale has no listing id -- so the branch most likely to recur is the
-- one branch the index does not cover.
--
-- It recurs by construction, not by accident. The route builds its `seenKeys`
-- set from `marketplace_sync_observations`, and a row lands there only when a
-- sale is CONFIRMED. An unmatched sold row is never confirmed, so it is never
-- in `seenKeys`, so every poll re-emits it with the same `dedupe_key` and the
-- route plain-inserts it again. At the poll's default 45-minute cadence that is
-- roughly 32 identical rows a day, per unmatched sold row, indefinitely -- and
-- GET /reviews returns only the newest 200, so the copies crowd out the real
-- queue.
--
-- `dedupe_key` is the right key for this branch: it is the platform's own order
-- reference where it prints one, else the listing URL plus the sold date, and
-- it is the same value the confirmed path already deduplicates on. count_gap
-- and circuit_breaker carry a NULL `dedupe_key` and stay excluded, which is
-- deliberate: those two describe the state of a whole read rather than one
-- sale, and each new read is a new fact about a different read.

-- Existing duplicates must go before the unique index can be built. Keeps the
-- OLDEST row of each group -- it carries the created_at the seller would have
-- seen first, and its id may already be referenced by a claim they have open.
DELETE FROM public.marketplace_sync_reviews r
USING public.marketplace_sync_reviews keep
WHERE r.status = 'open'
  AND r.listing_id IS NULL
  AND r.dedupe_key IS NOT NULL
  AND keep.status = 'open'
  AND keep.listing_id IS NULL
  AND keep.dedupe_key IS NOT NULL
  AND keep.user_id = r.user_id
  AND keep.platform = r.platform
  AND keep.dedupe_key = r.dedupe_key
  AND (keep.created_at, keep.id) < (r.created_at, r.id);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_sync_reviews_unmatched_uniq
  ON public.marketplace_sync_reviews (user_id, platform, dedupe_key)
  WHERE status = 'open' AND listing_id IS NULL AND dedupe_key IS NOT NULL;

COMMENT ON INDEX public.marketplace_sync_reviews_unmatched_uniq IS
  'US-2717: the listing_id IS NULL half of the review queue. An unmatched sale '
  'is re-observed on every poll and is never written to the dedupe ledger, so '
  'without this it accumulates one row per poll forever.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00633') on conflict do nothing;
