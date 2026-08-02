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
reviewed: 2026-08-02
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
