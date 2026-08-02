---
title: Reconciling eBay-ended and policy-removed listings
aliases: [End is a no-op, policy removal, stuck active]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-ebay.ts
  - services/edge-functions/src/lib/ebay-client.ts
reviewed: 2026-08-01
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
locally (listing → ended, item → drafted); only a transient 429/5xx blocks for
retry.

**Policy-removed listings vanish from the offers feed.** eBay drops them out of
the active offers response, so they come back from `listAllOffers` with **no
`listingId`**. The pull's `if (!o.listingId) skip` meant the local row stayed
"active" forever — the sync saw the absence and read it as no news. Now, if we
still hold a live local listing for that SKU, its absence reconciles it to
ended, which routes the item back to Drafts.

**Relist checked the wrong flag.** The withdraw-before-republish step was gated
on the local `is_active`, so a row that was stuck-active-but-actually-removed
skipped the withdraw and re-adopted the dead offer. It now withdraws whenever an
offer id exists.

## The helper that makes this safe

`isOfferAlreadyEndedError(err)` in `ebay-client.ts` splits the two cases that
look identical at the call site:

- **already not live** — 4xx/404, or a not-published message → **reconcile**
- **transient** — 429/5xx → **retry**

Every End/Relist path calls it rather than re-deriving the split, and it is
unit-tested directly. Getting this backwards in either direction is expensive:
retry-on-gone loops forever, reconcile-on-transient marks a live listing dead.

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
