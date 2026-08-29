---
title: Reconciling eBay-ended and policy-removed listings
aliases: [End is a no-op, policy removal, stuck active]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-ebay.ts
  - services/edge-functions/src/lib/ebay-client.ts
  - services/edge-functions/src/routes/flipdesk-automations.ts
  - services/edge-functions/src/lib/active-listings.ts
  - services/edge-functions/src/lib/marketplace-adapters/ebay.ts
  - services/edge-functions/src/lib/listing-lifecycle.ts
  - services/edge-functions/src/lib/ebay-listing-state.ts
  - services/edge-functions/src/lib/ebay-webhook-topics.ts
  - services/edge-functions/src/lib/ebay-notification-subscriptions.ts
  - services/edge-functions/src/routes/flipdesk-webhooks.ts
reviewed: 2026-08-28
tags: [ebay, listings, sync, gotcha]
summary: A listing eBay ended or removed used to stay "active" locally with End and Relist as silent no-ops; the fix is to treat "already not live" as success, not as an error - and to keep WHICH of those it was, since ended and removed-by-eBay need opposite actions.
---

# Reconciling eBay-ended and policy-removed listings

> **Re-reviewed 2026-08-28.** Drift flagged `flipdesk-ebay.ts` for US-2974,
> which adds an optional `item_id` query param to the COMPS SEARCH endpoint and
> stamps the comp pipeline stage for rewards after a successful lookup. It
> touches no lifecycle verb: nothing about ending, relisting, policy removal or
> the reconciliation sweep changed, and the stamp is best-effort precisely so a
> rewards problem cannot cost a seller the thing they asked for. Recorded rather
> than silently bumped, because this file is large and the drift guard cannot
> tell which part of it moved.

eBay can end a listing without telling us: a policy removal, or the seller ending
it in eBay's own UI. When that happens the local row must catch up. Three
separate bugs kept it from doing so, and all three share one root cause —
**"already not live" was being treated as a failure instead of as the desired
end state.**

## The three shapes

**End was not idempotent.** `withdrawOffer` throws on an offer that is already
gone (404/4xx). The handler returned a hard 502 and — the damaging part — never
updated the local row. So the one action a seller takes to fix a stuck listing
was guaranteed to leave it stuck. Now an already-not-live offer reconciles
locally: listing → ended, and item → drafted **only once nothing is live on any
marketplace** (`resyncItemListedStatus`, guarded in `lib/active-listings.ts`), so
ending the eBay half of a cross-listed item neither files a still-selling item
under Drafts nor frees an `activeListings` slot the seller still occupies. A
completed sale skips the item write entirely.

A multi-variation listing has no offer id and ends by group key via
`withdrawByInventoryItemGroup` (US-1978) — same classification, different call.

**And REVISES the same way, as of US-2395 (2026-08-15).** `resolveReviseStrategy`
is group-first, keyed on the pinned `listings.inventory_sku`, and mirrors
`resolveEndStrategy` deliberately: two resolvers in one file answering the same
question differently is what left revise 409-ing on a listing the end path
handled fine. The one divergence is intentional — no mechanism is `none` for
revise, not `local`. Ending locally is a real outcome; a revise that did nothing
must say so.

**Policy-removed listings vanish from the offers feed.** eBay drops them out of
the active offers response, so they come back from `listAllOffers` with **no
`listingId`**. The pull's `if (!o.listingId) skip` meant the local row stayed
"active" forever — the sync saw the absence and read it as no news. Now, if we
still hold a live local listing for that SKU, its absence reconciles it to
ended, and routes the item back to Drafts under the same two guards as above —
a completed sale skips the item, and `itemHasActiveListing` skips an item still
live on another marketplace (US-2179).

**Relist checked the wrong flag.** The withdraw-before-republish step was gated
on the local `is_active`, so a row that was stuck-active-but-actually-removed
skipped the withdraw and re-adopted the dead offer. It now withdraws whenever an
offer id exists.

## The helper that makes this safe

`isOfferAlreadyEndedError(err)` in `ebay-client.ts` splits the cases that look
identical at the call site. It is **three** ways, not two — the third is the one
that bites:

- **already not live** — 4xx/404, or a not-published message → **reconcile**
- **a fact about the CALLER** — 401/403 → **retry**, live state unknown. An
  expired token, a revoked grant, a missing `sell.inventory` scope, or a withdraw
  aimed at an offer a *different* connected account owns all answer 4xx while the
  listing stays up. Excluded from the already-ended arm in US-2641.
- **transient** — 429/5xx → **retry**, live state unknown
- **not connected** — `isNoEbayConnectionError`, thrown by `getUserAccessToken`
  *before* any withdraw is attempted → **retry, and never reconcile**. The
  listing is still live, so ending it locally is an oversell (US-1506). Callers
  must preempt this check rather than trust the message regex not to match.

A fourth case never reaches the classifier: an eBay-**origin** listing is
refused up front with 409 + `locked_fields` (US-1976) and is not reconciled at
all.

Getting this backwards in either direction is expensive, and asymmetrically so.
Retry-on-gone loops forever but a later tick can still fix it;
reconcile-on-transient marks a live listing dead, which nothing recovers. So
anything unclear must classify as **retry**.

> [!warning] Classify, then VERIFY (US-2641)
> The already-ended arm is an **inference**: "eBay refused the withdraw" is not
> the same fact as "the listing is not live". It is usually right and silently
> catastrophic when it is wrong — the row reads ended while buyers can still buy.
> So on the offer path both the eBay-namespaced end route and the adapter now
> re-read the offer after a failure and **refuse to mark the row ended while
> `getPublishedListingId` still returns a live listing**, answering 502 that names
> it. One read, only on the failure path.
>
> The same fix closed two contract violations the shared path had quietly
> inherited when US-2162 pointed the Listings page at it: `ebayAdapter.delist`
> dropped `marketplace_connection_id`, so it withdrew through whichever account is
> primary *today* (US-1507), and `loadOwnedListing` resolved the group key from
> the seller-editable `inventory_items.sku` instead of the pinned
> `listings.inventory_sku` (US-1999). Both produce a 4xx that reads as
> "already ended".

> [!warning] "Every path uses the helper" was true when written, then wasn't
> This section used to claim *every* End/Relist path called the helper rather
> than re-deriving the split. `flipdesk-automations.ts` was written afterwards
> and never adopted it: its end/relist `return false`d on **any** throw, so an
> already-ended listing left the row stuck "active" forever, on a schedule —
> the exact bug this whole note exists to document, reintroduced by the one
> path the note asserted was covered. Fixed in US-2388 via
> `classifyWithdrawFailure`, unit-tested in `automation-end-listing_test.ts`.
>
> The lesson is about the claim, not the code: **a statement of universality
> ages badly unless something enforces it.** It read as verification to every
> reviewer after the day it was written. If you find yourself writing "every X
> does Y" in a note, consider whether a source-scan guard can hold it.

## A listingId is not a pulse (2026-08-08)

The same confusion runs the other way too, and this direction is worse because
it reports **success**.

`publishOrAdoptOffer` (US-464) exists so a publish that succeeded on eBay but
crashed before the local write cannot be re-published into a duplicate. It asks
`getPublishedListingId` — which read `offer.listing.listingId` and returned it.

**eBay does not clear `listing.listingId` when a listing ends.** A withdrawn
offer still carries the id of its dead listing. So after an End, the very next
publish adopted that id, skipped `publishOffer` entirely, wrote the ended
listing's id to the local row, and told the seller *"your listing is live."* The
item was off eBay, the row said active, and the "View on eBay" link pointed at a
page reading ENDED.

That path is the **escape hatch** — end, fix the thing eBay would not let you
change in place, relist. It failed in the same place as the problem it exists to
escape, which is how a seller ends up with an unsellable item and an app
insisting otherwise.

`livePublishedListingId(offer)` now applies the status rule, and the asymmetry
in it is deliberate:

- `ENDED`, `INACTIVE`, `COMPLETED`, `CANCELLED`/`CANCELED` → **not live**, republish.
- Anything else, **including a missing `listingStatus`** → adopt, as before.

Adopting a dead listing costs a silent no-publish, which is recoverable and now
visible. Refusing to adopt a live one costs a **duplicate live listing**, which
is not recoverable and is the entire reason the check exists. Unknown statuses
therefore keep the old behaviour. Pinned by `publish-idempotency_test.ts`.

### The status rule was reading the wrong status (2026-08-16, US-2641)

The rule above works when eBay says `listingStatus: "ENDED"`. It does not when
eBay says nothing at all, and after a **seller ends the listing on eBay's own
site** that is the usual response: `offer.listing.listingId` still names the dead
listing, `listing.listingStatus` is frequently absent, and the "unknown adopts"
asymmetry then does exactly the thing this section was written to stop.

The offer answers the question directly. **`offer.status` goes back to
`UNPUBLISHED` when the listing ends**, and an offer that is not `PUBLISHED` has
nothing to adopt whatever it remembers. `livePublishedListingId` checks it first;
a *missing* offer status still falls through to the listing rules, so the safe
side is unchanged.

Same root cause, second symptom: **eBay will not re-publish an offer bound to a
dead listing.** It answers `25001 "A system error has occurred. Internal Server
Error"` to every attempt, forever — a seller who ended a listing on eBay and then
relisted from FlipDesk got it four times in a row with nothing that could clear
it. eBay's recovery is to destroy the offer and create a new one, so
`publishItemForOwner` now does that when `isOfferBoundToDeadListing` holds for
the offer it was about to reuse. That predicate is narrow on purpose: an offer
that merely failed to publish (a missing item specific) carries **no** listingId
and is left alone, so an ordinary rejection never churns the offer id and never
loses the `syncExistingOffer` correction that actually fixes it.

The relist flag is the third piece. `POST /listings/push` takes `relist`, which
is what withdraws the old offer before publishing; the Listings page has sent it
since US-560 and **the composer never did** — and the composer is where a seller
actually relists, since "end it, fix it, publish again" all happen on that one
page. Pinned by `relist-after-ebay-end_test.ts` and
`composer-relist-and-price-push.test.ts`.

> [!note] Read this next to the classifier above
> `isOfferAlreadyEndedError` decides whether an *error* means "already gone".
> This decides whether a *success payload* means "still live". Both are the
> question "is this listing alive right now?", and neither can be answered from
> the presence or absence of a field alone.

## Two words for every answer eBay gives (2026-08-16, US-2656)

Everything above is about deciding whether a listing is live. The sync then wrote
that decision down like this:

```ts
const isActive = (o.listingStatus ?? "").toUpperCase() === "ACTIVE";
listing_status: isActive ? "active" : "ended"
```

Every way a listing can stop being ACTIVE collapsed into one word. A seller who
ended it, a listing eBay pulled for a policy issue, a garment that sold out, and
an auction that closed with no bid were indistinguishable afterwards — and the
only explanation the app could offer was a hardcoded sentence that guessed three
ways at once ("it may have ended, sold out, or been removed by eBay"). Those need
OPPOSITE actions: an ended listing wants a relist, and one eBay took down wants
the seller to read their Seller Hub messages first, because relisting the same
content gets it removed again.

`lib/ebay-listing-state.ts` is now the single place that reads eBay's vocabulary.
Two properties are load-bearing:

- **OUT_OF_STOCK resolves to ACTIVE.** It is a live listing under eBay's
  out-of-stock control — same item id, still holding a slot, restockable. The old
  ternary called it ended, which invited a relist that would have minted a
  *second* listing beside the one still sitting there. Same failure family as
  [[#A listingId is not a pulse]].
- **An unrecognised status is carried verbatim** (`ebay_status`) with reason
  `unknown_status`, never folded into a neighbour. eBay has extended this enum
  before; carrying the raw word is how production tells us the real vocabulary
  instead of the data quietly agreeing with our guess.

The verdict lands on `listings.platform_fields.ebay_state`, written only on a
CHANGE — a steady-state sync of an ACTIVE listing stays write-free, and
`observed_at` keeps meaning "when it transitioned" rather than "when we last
looked". `ListingAlertMarkers` renders the three reasons the local enum cannot
express (`out_of_stock`, `inactive`, `unknown_status`) and stays silent for the
rest, because a banner over every healthy listing is a banner nobody reads.

### The listing bucket, and why adding it turned delivery on

`classifyEbayTopic` had buckets for order, payout, return and account-deletion.
It had none for LISTINGS, so `ITEM_CLOSED` / `ITEM_UNSOLD` / `ITEM_OUT_OF_STOCK`
classified as `unhandled` — and that is worse than it sounds, because
`ebay-notification-subscriptions.ts` derives what to SUBSCRIBE by running eBay's
own topic catalog through the same router and keeping the required buckets. An
unhandled topic was therefore never subscribed and never delivered. The only way
FlipDesk learned a listing had ended was the 30-minute backstop pull noticing it
was gone.

Adding `listing` to `REQUIRED_BUCKETS` is what turns delivery on; the receiver
routes it to the same targeted pull as order/return, deliberately, because
`doListingsPull` already reconciles both in one run and a second path would be
free to drift.

> [!warning] The ordering inside `classifyEbayTopic` is a correctness property
> `ITEM_UNSOLD` contains **SOLD**, so the listing tests must precede the order
> tests or an auction that closed without a buyer routes to the sale bucket.
> `RELISTED` contains `LISTED` the same way. In the other direction, the listing
> bucket claims `CLOSED`, which is why `CASE_` was added to the RETURN test — a
> buyer case resolving would otherwise have read as a listing event.

### A reversed sale does not say where the garment is

The sync classified a reversal by MONEY (`cancelState` / `orderPaymentStatus`)
and always put the item back to `listed`, while the in-app return path (US-1451)
wrote `returned`. Same physical event, two answers, decided by which code found
it first — and a return the seller handled in eBay's Seller Hub never arrived at
all, because the in-app path only runs from our own buttons.

`resolveOrderOutcome` splits it on FULFILMENT, which is the thing that actually
tracks the garment:

| eBay says | sale | garment |
|---|---|---|
| cancelled, not fulfilled | `cancelled` | never left → back to inventory, then `resyncItemListedStatus` decides `listed` vs `drafted` |
| refunded, FULFILLED | `refunded` | buyer had it and sent it back → `returned` |
| cancelled, FULFILLED | `cancelled` | physically a return → `returned` |

The cancel arm calls `resyncItemListedStatus` rather than trusting `listed`,
because a sale usually ended the eBay listing — so "listed" was often a lie, and
the item hid in a Listed tab with nothing behind it.

A reversal also now clears the listing row's `sold`. `{}` meant a sale that
completed and was LATER cancelled kept `listing_status = 'sold'` forever while
the item went back to `listed`: the listing insisting it sold, the item insisting
it was for sale, and nothing to reconcile them.

## Three answers to "is this listing live" (2026-08-16, US-2657)

The question this whole note is about was being answered in three places, three
different ways, and none of them said which one it was using:

| asker | rule |
|---|---|
| `itemHasActiveListing` (cap accounting) | `is_active = true` |
| the composer (`isLiveListing`) | `listing_status === "active"` AND an offer id |
| the item-delete guard | status-based, **plus** a published-DRAFT fallback |

The delete guard's version is the careful one, and its extra clause is the reason
the three cannot simply be collapsed onto `is_active`: a row still in `draft`
status that nonetheless reached the marketplace is live while `is_active` is
false, so `is_active` alone under-reports it.

But three answers meant a page could say DRAFT while the server said LIVE. A
seller deleting a DUPLICATE item hit exactly that: `"This item has a live
listing. End the listing first, then delete it."` on an item whose every screen
said draft. The sentence has no subject — it names no listing, no marketplace and
no reason — so there was nothing to act on, and the two cases it covers want
opposite responses (end it, versus realise the row points at the other copy of
the garment).

Then the trap closed: **End was not reachable either.** The composer renders it
only for `isLiveListing`, and the Listings page renders it only on the Active
tab. An item in this state could be neither deleted nor ended.

`isListingLive` / `liveBlockReason` in `lib/listing-lifecycle.ts` are now the
shared rule, and `liveBlockReason` is the load-bearing half: the 409 returns
`blocking_listings[]` with each row's platform, status, URL and reason, the
client offers "Open the listing", and `published_draft` gets its own wording
because a seller looking at a draft cannot be told they have a live listing. The
composer's End widens to any row that reached the marketplace — safe only
because End itself now verifies with eBay before reconciling
([[#Classify, then VERIFY (US-2641)]]) and refuses to mark anything ended while
eBay still reports it live.

> [!note] The lesson is the sentence, not the predicate
> The predicate was right. What made this cost a seller their afternoon is that
> a refusal stated a conclusion and withheld the evidence, on a screen that
> visibly contradicted it. A guard that blocks an action owes the caller the row
> it blocked on.

## Why the reason rides on a column, not the enum

The `listing_status` enum has `draft | active | ended | sold | relisted` and no
`rejected` or `inactive` member. Rather than widen it — an enum change is a
migration with its own caveats — the reason surfaces on
`listings.publish_error`, and is cleared on the next successful publish. The web
Drafts row renders an amber **"eBay inactive — review & relist"** badge from it.

## Quantity is the other pulse (2026-08-18, US-2684)

Everything above asks eBay for a *word* and decides what it means. The listing
also carries a *number*, and for a whole class of dead listing the number is the
only place the truth shows up.

eBay decrements `availableQuantity` when an order is placed. It does **not**
restore it when that order is cancelled. Under out-of-stock control the listing
then sits at zero indefinitely: still up, still holding its item id, its
watchers and its search standing, and unbuyable. eBay's own answer for it is
frequently `listingStatus: "ACTIVE"` rather than `OUT_OF_STOCK` -- so
`resolveEbayListingState` resolved it to a plain healthy listing, and every
surface downstream agreed.

`applyStockFloor` now overrules a live state when eBay reported an explicit
quantity at or below zero. Its asymmetries are the same family as
[[#A listingId is not a pulse]] and point the same way:

- The row stays `active` / `is_active`. Only the **reason** moves to
  `out_of_stock`. Calling it ended would send the seller to relist and mint a
  duplicate beside the listing still sitting there.
- A **missing** quantity is unknown, never zero. A stop-everything banner over
  a healthy listing is how a seller learns to ignore the banner.
- A state that is already not live is untouched. An ENDED listing at quantity 0
  is ended, not restockable.

### The two halves that made it cost an afternoon

Naming the state was the smaller half. The seller in the report could see the
listing was out of stock on eBay; what they could not do was anything about it.

**The composer's revise never sent the quantity.** `handleResubmitClick` pushed
the title, description, price, photos, category, condition and every item
specific, and omitted the one eBay-owned field that was wrong. The box was on
the form and saved to `listings.quantity`; it just never reached the offer. So
"Save & resubmit to eBay" -- the only verb the screen offered -- reported
success and changed nothing that mattered, indefinitely. It sends
`resolveQuantity(...)` now, which floors at 1, so an ordinary resubmit restocks.

**And the green banner said the opposite of the truth.** `isLiveListing` is true
for an out-of-stock listing, so the page rendered "buyers can purchase it now"
over one nobody could buy. It is gated on `!ebayOutOfStock` now, with an amber
banner in the same slot carrying a one-click **Restock on eBay**. That action is
deliberately narrower than resubmit -- quantity only, no photo sync, no
`resync_ebay_fields` -- because a listing that is unbuyable right now must not
have its fix blocked by eBay rejecting an unrelated item specific.

> [!warning] `listings.quantity` is not the signal on a GT-origin listing
> The provenance merge writes eBay's `availableQuantity` to the column only
> while `origin='ebay'` (`EBAY_OWNED_LISTING_FIELDS`). On a
> GradeThread-originated listing eBay's number is recorded as **drift** instead,
> so the column keeps reading 1 for the entire time the listing is dead. The
> `ebay_state` marker is what the UI must key on; the column is a fallback that
> only an eBay-origin mirror gets right.

### A reversal stopped overwriting the pull

Same story, one layer down. The orders pass wrote `listing_status: 'ended',
is_active: false` for **any** reversal, unconditionally. The offers pull runs
earlier in the same sync and flushes before it -- so on a cancelled order that
left the listing up, the sales pass undid a verdict taken from eBay minutes
earlier, and the next run wrote it back. The row alternated between `ended` and
`active` every 30 minutes and neither word was the true one, which is
"live, but nobody can buy it".

It consults `ebayStateByItem` now and keeps the pull's verdict when the pull
actually saw the listing, falling back to `ended` when it did not (no eBay
connection, a partial pull, an offer genuinely absent from the feed). The
**completed** arm is unchanged on purpose: a sale that stands must still mark
the listing sold and inactive, or the item holds an `activeListings` slot it no
longer occupies.

### Clearing the marker

`ebay_state` is written by the pull and **only on a change**, which is right for
dating a transition and wrong for a marker the seller has just acted on: after a
successful restock nothing would have rewritten it until eBay's next differing
answer, leaving the "nobody can buy this" banner standing for up to a full sync
interval. `clearReviseDrift(listingId, { restocked })` drops it on a revise that
raised the quantity above zero. Only the `out_of_stock` reason -- an `inactive`
verdict is not something a quantity push resolves.

Pinned by `ebay-listing-state_test.ts` (the floor, both directions) and
`src/test/ebay-out-of-stock-restock.test.tsx` (the composer and sync shapes,
verified to fail against the pre-fix code).

## Related

- [[ebay-condition-and-policies]] — a rejected condition is one way a publish fails
- [[ebay-aspect-value-limit]] — the other, and its stuck-offer failure mode
- [[cross-listing]] — which marketplaces have an offer lifecycle at all
- [[INDEX]]
