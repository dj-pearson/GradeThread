---
title: eBay orders backfill after a lost sync window
type: runbook
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-ebay.ts
  - services/edge-functions/src/lib/sync-watermark.ts
  - services/edge-functions/src/routes/jobs-ebay-order-backstop.ts
reviewed: 2026-08-01
tags: [ebay, flipdesk, sync, recovery]
summary: How to recover eBay orders that a pre-US-2320 sync skipped past, and how to tell whether a seller lost any.
---

# eBay orders backfill after a lost sync window

Until US-2320, the eBay orders pass caught every failure, logged it, carried on,
and then stamped `marketplace_connections.last_synced_at = now()`
unconditionally. The next incremental pull asks eBay only for orders modified
since that timestamp, so any order the failed pass never wrote was never asked
for again.

That is silent and permanent. The sync returned 202 `{ok:true}`, the UI said
"Synced just now", and the missing orders leave no row anywhere to notice them
by: no `sales` row, no payout, no `net_profit`, and the item stays in whatever
status it had instead of flipping to `sold`.

The backstop cron cannot recover it either — `jobs-ebay-order-backstop.ts`
selects stale owners by that same `last_synced_at`, which the failed run had
just refreshed.

## Who is affected

Any eBay connection whose sync hit a transient eBay error, or crossed the
200-page order ceiling, before US-2320 shipped. There is no stored marker for
those runs beyond the `errors` array on the sync-run rows, so treat **every**
eBay connection as potentially affected and run the backfill for all of them.

Symptoms a seller reports, none of which name the cause:

- An eBay order that never appeared in the Sold tab.
- An item still showing as listed after it sold.
- A consignor who was never paid for an item that sold.
- Revenue totals that are lower than the eBay seller dashboard's.

## The backfill

`POST /api/flipdesk/ebay/listings/pull?full=true` (on
`functions.gradethread.com` — see [[dns-and-routing]]) ignores `last_synced_at`
entirely and re-pulls the orders window back to eBay's practical retention
limit, ~23 months. That is the recovery: it is the existing user-facing "import
full sales history" action, run once per connection.

1. List active eBay connections: `marketplace_connections` where
   `marketplace = 'ebay'` and `is_active = true`.
2. For each, fire the pull with `full=true`, **as that user** — the route is
   tenant-scoped and derives the connection from the caller.
3. Space the runs out. Each one is a ~23-month order pull plus a Finances
   enrichment pass against eBay's rate limits; running every seller at once
   will trip them and produce the exact partial pass this runbook exists to
   clean up. One connection at a time, sequentially, is fine.
4. Re-check after each run. A run that reports `status: 'partial'` on its
   sync-run row did not finish — read its `errors` and run it again. Post
   US-2320 a partial run no longer advances the cursor past what it wrote, so
   re-running is safe and picks up where it stopped.

The pull is idempotent: existing sales are matched by
`(platform_order_id, line_item_id)` and updated in place, so a re-run of a
window that already imported cleanly writes nothing new.

## What it cannot recover

eBay's own retention. Orders modified more than ~24 months ago are rejected by
`getOrders` (errorId 30830) and cannot be pulled by any window. If a seller lost
orders older than that, the only source left is their eBay Seller Hub export,
imported manually.

## Why it cannot happen again

`planOrdersWatermark` (`lib/sync-watermark.ts`) now owns the cursor decision:

- fetch incomplete (a throw mid-paging, or the page ceiling) → the cursor does
  not move at all;
- orders fetched but not persisted → the cursor rewinds to the earliest failure
  so those orders re-pull;
- clean pass → `now()`, as before.

Shopify already worked this way — `flipdesk-shopify.ts` gates its watermark on
`ingest.ok`. Any new connector's cursor must be gated the same way; see
[[marketplace-connector-contract]].

Related: [[incident-response]] for the SEV process if a seller reports missing
revenue, [[deploy]] for shipping the fix ahead of the backfill.
