# Cross-listing: list everywhere in one click, and delist everywhere on a sale

Date: 2026-09-11
Status: approved in chat (founder chose the queue path), not yet built
Epic: filed in prd.json alongside this document

## The problem, as the founder hit it today

Two failures on the same garment, both on the extension channels (Poshmark,
Mercari, Grailed, Vinted).

**Listing.** After publishing to eBay, the seller opens the composer's Listing
Kit and presses "Send to extension" once per marketplace tab. Four channels,
four clicks, four tabs opened one at a time, and no way to say "all of them".
Nothing paces the runs.

**Selling.** The garment sold on Poshmark. The seller opened the Record Sale
dialog, which recorded the sale against the item and ended the eBay listing,
and did nothing about Mercari, Grailed or Vinted. There was no delist control
in the kit, no link to any of those listings, and the seller ended each one by
hand after remembering where it was listed.

Auto-delist that fires is the single loudest complaint in every crosslister
forum thread (`vault/50-business/competitors/forum-sentiment.md` section 4), and
the single most praised feature when it works.

## What already exists, and is reused rather than rebuilt

- `extension_work_queue` (migration 00588) with kinds `list | delist | revise |
  relist`, drained by `extension-unified/background.js` `drainQueue()` on a
  5-minute alarm, on browser start, on a web nudge, and every 60 seconds while
  the pinned worker tab (US-3061) is open. One job at a time, by design.
- `lib/cross-push.ts` `crossPushPlatform()` already fans one draft out to many
  platforms, creates the sibling `listings` row, pre-flights it, and for an
  extension channel enqueues a `list` job (US-3213). The composer's Publish
  button and the `crosslist_to` automation both call it.
- `lib/cross-listings.ts` `autoEndCrossListings()` plans and executes the
  sibling delist on a sale: API channels are ended server-side, extension
  channels get `delist_requested_at` stamped AND a `delist` queue row
  (US-3141), and one notice goes out. Every API order path calls it.
- `lib/extension-writeback.ts` records the marketplace URL on
  `listings.listing_url` when the extension sees the tab land on the live
  listing (`/api/grading/public/listed-confirm`). The INSERT failed on every
  environment until migration 00634 (US-2727); the schema is confirmed fixed in
  prod as of 2026-09-11 and nobody has retried the flow since.
- `PendingDelistBanner` + `usePendingDelists` on the Listings page: End
  listing / Mark ended / Run on my desktop per stamped row.

## Constraint

`vault/60-decisions/adr-no-server-side-marketplace-automation.md` governs.
Nothing here stores a marketplace credential or session, and nothing here
answers a CAPTCHA. The queue stores WHAT to do and the seller's own browser does
it. This design adds no new mechanism; it connects the ones above.

## Decision: "List everywhere" goes through the queue, not through N tabs

Founder's call, 2026-09-11. The queue is paced, survives a closed tab, is the
same path the phone apps use, and the worker tab drains it. Opening four tabs at
once has no pacing, and one login wall stops the whole run.

## Part A: listing side

### A1. The kit gets a channel checklist and one button

In `src/components/flipdesk/listing-kit.tsx`, above the tabs:

```
List on:  [x] Poshmark   [x] Mercari   [ ] Grailed (live)   [x] Vinted
[ List everywhere ]   Runs one at a time in your browser, about 30s apart.
```

- Channels offered: `kitPlatformsFor(chosen)` minus Depop (API-pending, no
  extension form-filler) and minus any channel whose
  `MARKETPLACE_EXTENSION_FLOW` is `verifying`.
- Pre-checked: channels that are neither live nor queued for this item.
  A live channel renders unchecked with "(live)" and cannot be checked; a queued
  one renders "(queued)" and cannot be checked.
- Click calls the existing `POST /api/flipdesk/listings/cross-push` with
  `{ listingId: <eBay draft id>, platforms: <checked> }`. No new fan-out code.
- Toast reports per channel from the cross-push result: queued / already live /
  already queued / blocked (with the first blocker). The QUEUED_NOTICE sentence
  follows, verbatim, as everywhere else.
- Then `requestDrainNow()` so an open extension starts within seconds instead of
  at the next 5-minute tick.
- The per-tab "Send to extension" button stays. It is the interactive path for
  one channel when the seller wants to watch the form fill. Its label becomes
  "Fill {Platform} now" so the two verbs read as different things.

### A2. Cross-push must refuse to re-list a channel that is already live or queued

`lib/cross-push.ts` `crossPushPlatform()` enqueues unconditionally for an
extension channel. Re-pushing a channel that already has an `active` row with a
`listing_url` would open the create form again and mint a duplicate listing. A
channel with a `queued`/`claimed` `list` row would be queued twice.

Add a guard before the enqueue, server-side so the automation gets it too:

- existing sibling row is `active` and has `listing_url` -> return
  `{ ok: true, skipped: "already_live", listingUrl }`, no enqueue.
- a `queued` or `claimed` `list` row exists for `(owner, listing_id)` -> return
  `{ ok: true, skipped: "already_queued" }`, no enqueue.

`CrossPushOutcome` gains `skipped?: "already_live" | "already_queued"`. The
composer's Publish toast and the new kit toast both read it. The `crosslist_to`
automation runner treats a skip as a no-op success.

### A3. Pacing between list jobs, in the extension

`extension-unified/lister/job-store.js` gains a pure `pacingHold(state, now)`
and `nextListDrainAt(settledAt, gapMs, jitterMs, rng)`. `background.js`
`reportJob()`: when a `list` job settles, record `lastListSettledAt` in
`storage.local` and schedule the next drain through a one-shot `chrome.alarms`
alarm at `now + gap` instead of calling `drainQueue()` immediately. Delist,
revise and relist jobs keep the immediate re-drain: a delist is the urgent
verb and pacing it is how a double sale happens.

`drainQueue()` checks `pacingHold` before `/claim` and returns `"paced"` while
held, so a row is never claimed by a browser that is about to sit on it.

Gap default 30 seconds with plus or minus 15 seconds of jitter. The options
page gets "Gap between cross-posts" with 15s / 30s / 60s / 2min, stored in
`storage.local` like the other options. The worker tab's status line shows
"next cross-post in Ns" during a hold.

No per-platform daily cap in this pass. It needs a `/claim` filter by platform
so a capped platform's rows are not claimed and stranded; that is its own
story.

### A4. Per-channel status in the kit, with the link and the End button

Each kit tab trigger carries a small state marker, and each panel opens with
one status row. State is derived client-side from two reads the page already
makes or can make cheaply: `useItemListings(itemId)` (all `listings` rows for
the item) and `useExtensionQueue()` filtered to this `inventory_item_id`.

Pure function `deriveChannelState(rows, queueItems, platform)` in
`src/lib/channel-state.ts`, unit-tested, returning one of:

| state | when | panel row |
|---|---|---|
| `live` | row `active` | "Live on Poshmark since <date>. [View on Poshmark] [End listing]" |
| `queued` | `list` queue row `queued`/`claimed` | "Queued for your desktop, <age>. [Cancel]" (Cancel only while `queued`, per US-3048) |
| `delist_queued` | `delist` queue row `queued`/`claimed`, or `delist_requested_at` set | "Ending on Poshmark from your browser. [Open] [Mark ended]" |
| `prefilled` | row `draft` created by the writeback | "Form was filled but not confirmed live. [I published it]" |
| `failed` | latest queue row `failed`/`expired` for this platform | the row's `result.error` and [Retry] (re-enqueue) |
| `ended` | row `ended` | "Ended <date>. [Relist]" only if the platform's relist flow is live, else nothing |
| `sold` | row `sold` | "Sold here <date>." |
| `none` | nothing | no row |

"View on {Platform}" reads `listings.listing_url` through the existing
`safeHref()`. "End listing" calls the existing `useEndListing` mutation
(`POST /listings/:id/end`).

### A5. End listing on an extension channel also queues the job

`lib/listing-lifecycle.ts` `endOwnedListing()` stamps `delist_requested_at` for
an extension channel and returns `queued: true`, but never inserts an
`extension_work_queue` row, so nothing runs it until a human clicks the banner.
Export `queueExtensionDelist` from `lib/cross-listings.ts` and call it from
`endOwnedListing` after the stamp, with `deliverExtensionWake`. Same dedupe rule
(no second row while one is queued or claimed).

### A6. The item page names every channel

`src/pages/flipdesk/item.tsx` renders eBay-only listing cards. Add a
`CrossListingsCard` under them listing every non-eBay row: platform, state (the
same `deriveChannelState`), the link, and End / Mark ended. Renders nothing when
the item has no non-eBay rows.

## Part B: sold side

### B1. Record Sale asks where it sold, and the server does the rest

`src/components/flipdesk/record-sale-dialog.tsx` gains a "Sold on" select
listing the item's listing rows by platform label (eBay, Poshmark, ...), plus
"Somewhere else / in person". Default: the single `active` row if there is
exactly one, else eBay if it has an eBay row, else "Somewhere else".

The dialog stops writing to Supabase from the client. It calls a new edge route:

```
POST /api/flipdesk/sales/record
{
  inventory_item_id, listing_id | null,
  sale_price, shipping_collected, platform_fees, payment_processing_fees,
  shipping_cost, tax, other_costs, buyer_username, sale_date
}
->
{ ok, sale_id, ended: n, queued: [platform...], unresolved: [platform...],
  nothing_live: n }
```

The route, in `routes/flipdesk-sales.ts` with the body in
`lib/record-sale.ts` so it has one testable owner:

1. Owner-check the item and, if given, the listing (`.eq("user_id", ownerId)`
   / via `inventory_items.user_id`). US-268.
2. Insert the `sales` row with `net_profit` computed server-side from the same
   formula the dialog previews (moved into a shared pure function
   `computeNetProfit` in `src/lib/sale-math.ts` mirrored in the edge; a test
   pins the two to the same answer).
3. Advance the item to `sold` (the same `status` write `advanceItemStatus`
   performs, done server-side).
4. If `listing_id` given: decrement quantity when more than one unit remains,
   else mark that row `sold`, `is_active: false`, `quantity: 0`. If that row
   is an API channel, end it upstream best-effort through
   `attemptUpstreamDelist` (a sale on eBay has usually already ended it; the
   classifier treats already-ended as success).
5. Call `autoEndCrossListings(ownerId, listing_id)` and return its summary.
   When `listing_id` is null (sold in person), call it for each `active` row
   on the item instead, so every live listing is pulled.

The dialog toasts from the summary: "Sale recorded. Ending it on Mercari and
Vinted from your browser. Grailed needs you: end it there." Then it
invalidates `pending_delists`, `extension_queue`, `item_listings`,
`items_full`, and calls `requestDrainNow()`.

### B2. The sibling planner must include the group anchor

`autoEndCrossListings` selects siblings by `draft_id = X` where X is the sold
row's `draft_id`. The extension writeback sets `draft_id` on the Poshmark row to
the eBay draft's id, but the eBay row's own `draft_id` is null unless a
cross-push ever ran `ensureCrossListingGroup`. So a Poshmark sale finds no eBay
sibling and eBay stays live.

Fix in `lib/cross-listings.ts`: select rows where `draft_id = X OR id = X`
(`.or()` on a SELECT is fine per the US-1552 gotcha), still excluding the sold
row and still tenant-scoped. Pinned by a test that seeds an anchor with a null
`draft_id`.

### B3. The pending-delist banner shows on the composer and the item page

`PendingDelistBanner` takes an optional `itemId` and filters to that item. It is
rendered above the Listing Kit in the composer and above the new
`CrossListingsCard` on the item page, so the delist controls are where the
seller looks after a sale, not only on the Listings page.

## Part C: a filled form is recorded as listed, and the seller opts out

Added by the founder mid-build (2026-09-11), reversing US-1877's
prefill-is-a-draft: "I would rather record that it may be listed and opt out
than opt in, forget about it, and later when something sells be unsure where
it is posted."

- The writeback records a prefill as `listing_status: active` with
  `platform_fields.listed_unconfirmed = { at }` and `listed_at: now`, under the
  same activeListings cap gate as a publish. A refused prefill falls back to
  the old draft record instead of blocking a form that is already filled.
- A captured live URL (the extension's tab watch) or the seller's "Yes, it is
  listed" clears the marker. Either sends one in-app notice
  (`notifyExtensionListed`, type `listing_live`) naming "Not listed"; a bare
  prefill sends the "recorded as listed" form of it.
- `POST /api/flipdesk/listings/:id/not-listed` puts the row back to a draft
  (URL, marker, listed_at and any delist stamp cleared) and re-derives the item
  status. Extension channels only; a sold row is refused.
- A drained `list` job records the same way from `/extension-queue/:id/complete`.
- The channel state gains `unconfirmed`; the kit row offers "Not listed" and
  "Yes, it is listed"; the item card offers "Not listed" on unconfirmed and live
  extension rows; cross-push skips an unconfirmed row as already live.

## Out of scope for this build (operator work, filed separately)

- Flipping on the Poshmark and Mercari sold-page observers (US-2698, US-2700).
  One sitting with a logged-in account. After that a Poshmark sale is detected
  without the Record Sale dialog.
- `EXTENSION_ALLOWED_ORIGINS` on the Coolify edge (US-2718 AC2), and one
  human retry of Send to extension to close US-2727.
- A Depop extension form-filler (Step 2 to 8 of
  `vault/30-platform/closing-a-coverage-gap.md`); needs a human on the live
  Depop sell form to verify selectors.
- Per-platform daily caps (needs a platform filter on `/claim`).
- Verifying US-2738 (photo attach reported when none landed) and US-2739
  (Poshmark price units) on the live form; the code fixes are in.

## Testing

- `src/lib/__tests__/channel-state.test.ts`: every state in the A4 table, and
  the precedence when a row and a queue item disagree (queue `failed` beats row
  `draft`; row `active` beats a stale `done` queue item).
- `services/edge-functions/src/tests/cross-push-skip_test.ts`: already-live
  and already-queued skips, and that a `draft` row without a URL is NOT skipped.
- `services/edge-functions/src/tests/record-sale_test.ts`: sale insert, item
  advance, quantity decrement vs mark sold, the summary shape, and a
  `tenant-isolation_test.ts` case for the new route (US-268 rule).
- `services/edge-functions/src/tests/cross-listings-anchor_test.ts`: the B2
  anchor-with-null-draft_id case.
- `extension-unified/test/lister-pacing.test.cjs`: `pacingHold` and
  `nextListDrainAt` (gap, jitter bounds, delist never held, held drain returns
  `"paced"` without calling `/claim`).
- `src/lib/__tests__/sale-math.test.ts` pinning `computeNetProfit` against the
  edge copy by source equality of the formula.
- `npm run verify` green before the commit, per CLAUDE.md.

## Migration

None. Every column this design reads or writes exists: `extension_work_queue`,
`listings.listing_url`, `listings.delist_requested_at`, `sales`.
