---
title: eBay orders backfill after a lost sync window
type: runbook
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-ebay.ts
  - services/edge-functions/src/lib/sync-watermark.ts
  - services/edge-functions/src/routes/jobs-ebay-order-backstop.ts
reviewed: 2026-08-23
tags: [ebay, flipdesk, sync, recovery]
summary: How to recover eBay orders that a pre-US-2320 sync skipped past, how to tell whether a seller lost any, and why the run status field is the wrong thing to check.
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
4. Re-check after each run — but **`status: 'partial'` is not the signal.**
   `status` is `partial` whenever the run's `errors` bag is non-empty from **any**
   phase (the `errors` bag in `flipdesk-ebay.ts`), and that bag collects conflicts, orphan
   orders, and a Feed-report failure that then succeeded via the paged path. A
   run can be `partial` and have pulled every order correctly.

   Grep `errors` for the cursor lines instead. Only these two mean the orders
   pass did not finish:

   - `orders: sync cursor NOT advanced (<reason>). This sync is PARTIAL…`
     (grep the literal string in `flipdesk-ebay.ts`)
   - `orders: N order(s) not saved — sync cursor held at …`
     (grep the literal string in `flipdesk-ebay.ts`)

   Either one ⇒ run it again. Post US-2320 the cursor never advances past what
   the run actually wrote, so re-running is safe and picks up where it stopped.

> [!warning] This runbook told operators to trust `status` (corrected 2026-08-08)
> It said a `partial` run "did not finish". Read that way, an operator re-runs a
> 23-month pull for every seller whose run had one unmatched orphan order — and,
> worse, learns that "partial" is noise and stops re-running the ones that
> genuinely stalled. The status field was never phase-specific; the note assumed
> it was. This was an authoring error at the note's first review, not drift.

The pull is idempotent: existing sales are matched by
`(inventory_item_id, platform_order_id, line_item_id)` — the lookup is scoped by
the item first (the `.from("listings")` lookup in `flipdesk-ebay.ts`) — and updated in place, so a re-run of a
window that already imported cleanly writes nothing new. The two-column
`(user_id, platform_order_id, line_item_id)` key belongs to a different table,
`flipdesk_ebay_orphan_sales`; do not reach for it here.

> [!warning] The line numbers in this note were all wrong (2026-08-22)
> Every `flipdesk-ebay.ts:NNNN` pointer here — `:3767`, `:3742`, `:3729`,
> `:3286`, `:3111` — resolved to unrelated code: a `case "REFUND":`, a
> `payoutId: null`, a type field, a table name, a mid-sentence comment. The file
> gained fifteen commits' worth of edits and the numbers slid with it, silently,
> because nothing checks a line number.
>
> They are now anchored by symbol and by grep-able string. Follow that here: a
> line number is a claim that expires without anyone touching the note, and this
> is a runbook someone reads mid-incident.

## What it cannot recover

eBay's own retention. Orders modified more than ~24 months ago are rejected by
`getOrders` (errorId 30830) and cannot be pulled by any window. If a seller lost
orders older than that, the only source left is their eBay Seller Hub export,
imported manually.

The two numbers in this note are not a contradiction: **eBay's limit is ~24
months; our floor is 700 days (~23)**, the `ebayLookbackFloor` constant in
`flipdesk-ebay.ts`. The month of margin is deliberate — asking right up to
eBay's edge earns a 30830 that fails the whole pass rather than trimming it.

## Why it cannot happen again

`planOrdersWatermark` (`lib/sync-watermark.ts`) now owns the cursor decision:

- fetch incomplete (a throw mid-paging, or the page ceiling) → the cursor does
  not move at all;
- orders fetched but not persisted, **and the earliest failure has a usable
  `lastModifiedDate`** → the cursor rewinds to that timestamp so those orders
  re-pull;
- orders fetched but not persisted, **and that timestamp is null or
  unparseable** → reason `undatable_failure`, and the cursor **freezes** rather
  than rewinding (`sync-watermark.ts:65`). There is nowhere safe to rewind to, so
  it holds. An operator seeing `undatable_failure` in `errors` is looking at a
  data-shape problem in eBay's response, not a rate limit;
- a failure timestamped in the future → reason `rewound`, advances to `now()`
  (`sync-watermark.ts:72`) — a defensive branch against a bad clock;
- clean pass → `now()`, as before.

The authoritative list is the `WatermarkPlan` union at `sync-watermark.ts:38`.
This note listed three of the five until 2026-08-08, and the missing
`undatable_failure` is the one an operator is most likely to actually see in a
`reason` string with nothing to match it against.

Shopify already worked this way — `flipdesk-shopify.ts` gates its watermark on
`ingest.ok`. Any new connector's cursor must be gated the same way; see
[[marketplace-connector-contract]].

Related: [[incident-response]] for the SEV process if a seller reports missing
revenue, [[deploy]] for shipping the fix ahead of the backfill.
