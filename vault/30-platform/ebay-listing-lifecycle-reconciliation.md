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
reviewed: 2026-08-15
tags: [ebay, listings, sync, gotcha]
summary: A listing eBay ended or removed used to stay "active" locally with End and Relist as silent no-ops; the fix is to treat "already not live" as success, not as an error.
---

# Reconciling eBay-ended and policy-removed listings

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

> [!note] Read this next to the classifier above
> `isOfferAlreadyEndedError` decides whether an *error* means "already gone".
> This decides whether a *success payload* means "still live". Both are the
> question "is this listing alive right now?", and neither can be answered from
> the presence or absence of a field alone.

## Why the reason rides on a column, not the enum

The `listing_status` enum has `draft | active | ended | sold | relisted` and no
`rejected` or `inactive` member. Rather than widen it — an enum change is a
migration with its own caveats — the reason surfaces on
`listings.publish_error`, and is cleared on the next successful publish. The web
Drafts row renders an amber **"eBay inactive — review & relist"** badge from it.

## Related

- [[ebay-condition-and-policies]] — a rejected condition is one way a publish fails
- [[ebay-aspect-value-limit]] — the other, and its stuck-offer failure mode
- [[cross-listing]] — which marketplaces have an offer lifecycle at all
- [[INDEX]]
