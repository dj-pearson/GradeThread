---
title: Reconciling eBay-ended and policy-removed listings
aliases: [End is a no-op, policy removal, stuck active]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-ebay.ts
  - services/edge-functions/src/lib/ebay-client.ts
  - services/edge-functions/src/lib/ebay-sku.ts
  - services/edge-functions/src/routes/flipdesk-automations.ts
  - services/edge-functions/src/lib/active-listings.ts
  - services/edge-functions/src/lib/marketplace-adapters/ebay.ts
  - services/edge-functions/src/lib/listing-lifecycle.ts
  - services/edge-functions/src/lib/ebay-listing-state.ts
  - services/edge-functions/src/lib/ebay-webhook-topics.ts
  - services/edge-functions/src/lib/ebay-notification-subscriptions.ts
  - services/edge-functions/src/routes/flipdesk-webhooks.ts
  - services/edge-functions/src/routes/jobs-ebay-notification-reconcile.ts
reviewed: 2026-09-22
tags: [ebay, listings, sync, gotcha]
summary: A listing eBay ended or removed used to stay "active" locally with End and Relist as silent no-ops; the fix is to treat "already not live" as success, not as an error - and to keep WHICH of those it was, since ended and removed-by-eBay need opposite actions.
---


> [!note] Re-reviewed 2026-09-22, and one rule this note owns GREW (US-3458).
> Two hunks in `flipdesk-ebay.ts`. (1) `GET /oauth/callback` now fires
> `triggerEbaySyncForUser(userId, "full")` after `upsertConnection`, so the
> first catalog pass happens on connect rather than on a Sync click. (2) Inside
> `doListingsPull`, after the orphan flush, every `unmatched` orphan with no
> `matched_item_id` whose normalized title matches no local item becomes an
> `inventory_items` row (`status: listed`) plus a `listing_origin: "ebay"`
> `listings` row plus reference `item_photos`, and the orphan flips to
> `matched` (`lib/ebay-orphan-adopt.ts`, capped at 1,000 per pass; a title
> match is held for the seller). The part that touches THIS note: both
> active-listing passes now resolve a listing through `platform_listing_id`
> when the SKU index cannot (`listedEbayItemToItemId`, built from the same
> listings preload). Until now an adopted or hand-linked orphan carried no SKU
> the index could resolve, so it was re-filed as an orphan on every pass and
> never refreshed; from this commit it is a matched listing, which means the
> price/quantity/status observations, the provenance merge and the
> **ended-without-sale sweep** all apply to it. That is the intended
> consequence: a listing that ended on eBay now drops its adopted item back to
> draft like any other. The Foreign class in the SKU section below shrinks to
> orphans the seller has ignored. Everything else here is unchanged.

> [!note] Re-reviewed 2026-09-20. Drift from `e7d84ab3a`, which touches
> ``ebay-client.ts` and `flipdesk-ebay.ts``. Read the diff rather than the dates: it is confined to
> `syncBusinessPolicies` and the new `SyncedPolicies.replacedDefaults` -- when
> a seller deletes the eBay policy their stored default points at, the sync now
> repoints that kind to the account's first policy of the kind, clears the dead
> `is_default` row by exact id, and reports the kinds so the caller can say so
> once. Business-policy defaults only.
>
> This note makes no claim about them, which was checked rather than assumed:
> it contains none of `is_default`, `business_polic`, `syncBusinessPolicies` or
> `readCachedDefaults`. The lifecycle states and the reconciliation rules this note owns are untouched; the `flipdesk-ebay.ts` hunk is one added response field.
>
> ⚠ Worth recording, because this is the fifth note that commit drifted:
> `ebay-client.ts` is 2,400 lines and seven contract notes list it in
> `code_refs`, so ANY change to it drifts all seven. `code_refs` carry no line
> ranges, and CONTRACT.md says drift is a heuristic. That is the heuristic
> being coarse rather than a note going stale.

> **Re-reviewed 2026-09-11.** flipdesk-ebay.ts changed for US-3265, confined to the policy-create handler
> (opt-in read-back, and requiring all three policies back as defaults before
> reporting success). No lifecycle verb moved. Re-read against the diff: still
> accurate.

# Reconciling eBay-ended and policy-removed listings

> **Re-reviewed 2026-09-10, no change.** Five of this note's `code_refs` moved
> at once. `flipdesk-ebay.ts` took six commits, and two of them land INSIDE
> `doListingsPull`, which is the function this note spends most of its length on:
> `7e79a2015` and `b817b83fb` mirror eBay's picture URLs onto `item_photos` as
> reference rows, accumulating them in a `photoUrlsByItem` map flushed after the
> listing writes, and widen the legacy `GetItem` call from "specifics are blank"
> to "this item has never been asked". Additive on both passes. Nothing about
> matched-versus-orphan, the absent-from-the-feed reconcile, or the status flips
> changed. The other four: `a54057305` adds `POST /policies/create` (business
> policies, not condition policies, and not a lifecycle verb), `fed4f2798` adds
> `resolveShippedAt` to the sales write, `3fe3e7d38` is offer net-proceeds, and
> `a97f06164` adds `shipByDate` to `RemoteOrderLineItem`. `listing-lifecycle.ts`
> and `flipdesk-automations.ts` both changed for the same reason, US-3192's
> per-garment price floor: `loadOwnedListing` selects and returns
> `item_floor_price`, and the automations loaders carry `floor_price` into
> `planAction` and `OfferContext`. Neither touches End or Relist, and
> `classifyWithdrawFailure` is still at `flipdesk-automations.ts:775`.
> Re-verified at HEAD: `isListingLive` at `listing-lifecycle.ts:133`,
> `liveBlockReason` at `:150` with `"active_status" | "published_draft" | null`,
> `livePublishedListingId` at `ebay-client.ts:3104`, `resolveEbayListingState`
> at `ebay-listing-state.ts:133` with `applyStockFloor` at `:158`, and the
> `listing_status` enum still exactly `draft | active | ended | sold | relisted`
> (no `ALTER TYPE` on it exists in any migration).

> **Re-reviewed 2026-09-05, no change.** Drift flagged `flipdesk-ebay.ts`
> for US-3068's extraction of `planEvidence` into `lib/evidence-plan.ts`,
> moved verbatim. It is post-sale evidence assembly and never calls End,
> Relist or the active-listing sweep, so the ended-versus-removed distinction
> this note defends is untouched.

> **Re-reviewed 2026-09-03.** Drift flagged `ebay-client.ts` and
> `ebay-notification-subscriptions.ts` for `57eff0f03`, and `ebay-client.ts`
> again for `f9144c69a`. The first adds `isOfferNotFoundError`: `listOffersForSku`
> now returns an empty list on eBay's 404 + errorId 25713 ("This Offer is not
> available"), and an unlabelled 404 still throws, so a wrong host or a revoked
> scope cannot read as an empty catalog. In the subscriptions module the topic
> catalog's wire fields became `unknown` and are read through `tokens()` /
> `scalar()`, because eBay sent a non-string `format` and the reconcile cron
> crashed on `.toUpperCase`. Neither touches a lifecycle verb: the router in
> `ebay-webhook-topics.ts` still decides what is subscribed, and the
> already-not-live classification in `isOfferAlreadyEndedError` is untouched.
> The second commit is the US-3098 sourcing filters on Browse comps (price,
> buying options, conditions, shipping, sort), which is search-side only.

> **Re-reviewed 2026-09-02, and one lifecycle verb genuinely grew a second
> meaning.** US-9203 adds RELIST ON EXTENSION CHANNELS, and it is not this
> note's relist: on eBay a relist happens under the existing offer, while on
> Poshmark, Mercari, Vinted and Grailed there is no API, so a "relist" is the
> seller's own browser COPYING the live listing into a new one. The new row is
> created at request time (`lib/extension-relist.ts`), the OLD row is ended and
> given `delist_requested_at` only once the copy is confirmed live, and until
> that confirmation both rows exist. Two consequences for the reconciliation
> this note owns: a sold-sync running in that window can still match the old
> row, which is why the old one is ended rather than deleted; and
> `flipdesk-automations.ts` now evaluates extension-channel rows for relist
> rules, guarded by a `viewsKnown` fact so `no_views_in_days` can never fire on
> a row that has never had a performance sync. eBay's own end/relist/policy
> removal handling is unchanged.
>
> **Re-reviewed 2026-08-31.** Drift flagged `ebay-client.ts` for `fb9de8279`,
> the numeric-id coercion. The whole change to this file is one additive hunk
> at the end adding `ebayId()`; the callers it repairs are the post-order
> modules (inquiries, cases, disputes, returns), none of which is a lifecycle
> verb and none of which is a `code_ref` here. Nothing about ending, relisting,
> policy removal or the reconciliation sweep moved. Re-verified while here: the
> "already not live is the desired end state" branch is still at
> `ebay-client.ts:3230`, and the seller-side-end comment at `:2819`.

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

## The SKU eBay holds is not the SKU on the item (2026-09-11, US-3357)

Everything above assumes the pull can find the local item behind an eBay
listing. It finds it through one map, built once per pass in `doListingsPull`:

```ts
// skuToItemId: inventory_items.sku -> inventory_items.id
.from("inventory_items").select("id, sku, ...").eq("user_id", userId)
```

**eBay is not keyed on that column.** `deriveInventorySku` (`lib/ebay-sku.ts`)
mints the Inventory API key at publish, and `listings.inventory_sku` (migration
00477) pins what the listing actually went live under. The two agree only when
the seller typed a SKU into the composer's *SKU / Item #* field and never
changed it. That field is optional, `composer-save.ts` saves it as
`trimOrNull(state.storageSku)`, and `inventory_items.sku` is a nullable column
with no default and no trigger. A blank field therefore publishes under
`FD-<first 8 of the item uuid>` while the local row keeps `sku = NULL`.

So four classes of SKU come back from `GET /sell/inventory/v1/inventory_item`
that `skuToItemId` cannot resolve:

| Class | Where the SKU came from | Recoverable locally? |
|---|---|---|
| Minted | item published with a blank SKU, so eBay holds `FD-xxxxxxxx` | yes, via `listings.inventory_sku` |
| Renamed | seller edited `inventory_items.sku` after publishing (the case 00477 was written for) | yes, same column |
| Variant | `variantSku(baseSku, variant)` per member of a variation listing; only `baseSku` is stored | yes, by re-deriving from `listings.variations` |
| Foreign | listed by another tool, or left behind after the local item was deleted | no |

### What that costs

1. **The item's own live listing is reported as an orphan.** The offer falls to
   the `else` branch and is upserted into `flipdesk_ebay_listings` with
   `title: null`, so the seller is asked on the Reconciliation page to link a
   listing GradeThread itself published. The legacy Trading pass would have
   supplied the title, but it dedupes against `processedListingIds`, which the
   modern pass has already filled, so the better record never gets written.
2. **Ended-without-sale never fires for those items.** `endedItemIds.add` and
   the absent-listing branch both sit behind a resolved `itemId`. An unsold
   listing on a blank-SKU item stays `listed` locally forever, which is the
   single thing the per-SKU offer read exists to catch (see `OFFER_RECHECK_MS`).
3. **The read is never remembered, so it is paid on every pass.** The US-3111
   stamp is `update(inventory_items).eq(user_id).in("sku", chunk)`, and an
   UPDATE matching no row is a 200 with an empty body, not an error. US-3110
   made the gap countable as `offers_unstamped` on the pull-complete line.

### Why this is not a missing table

The obvious repair for (3) is a memo table keyed `(user_id, sku)` holding a
`checked_at`. It is the wrong shape: three of the four classes above resolve to
an inventory item that already has an `ebay_offer_checked_at` column, so a memo
table would be storing a second answer to a question the schema can already
answer, and the fourth class should not be asked about at all. The rows would
also never be pruned, because nothing deletes an eBay inventory item when a
local item is deleted: `DELETE /items/:sku` requires a matching
`inventory_items.sku` row, which by definition these do not have.

The repair is a join, and it needs no migration. Migration 00477 already created
`idx_listings_user_inventory_sku ON listings (user_id, inventory_sku) WHERE
inventory_sku IS NOT NULL` for exactly this lookup. Resolve each eBay SKU to an
`inventory_items.id` through that index, stamp `.in("id", ids)` instead of
`.in("sku", skus)`, and feed the same map to `selectSkusToSkip`. The residue
after that is the Foreign class alone, and for an ACTIVE foreign listing the
legacy `GetMyeBaySelling` pass already produces a richer orphan row in seven
paged calls rather than one call per SKU, so the per-SKU read buys nothing.

### Reading the size of it

The Minted and Renamed classes are countable from the database without touching
a container log or eBay:

```sql
select count(*) filter (where l.inventory_sku like 'FD-%')            as minted,
       count(*) filter (where l.inventory_sku not like 'FD-%')        as renamed,
       count(*)                                                       as total
from public.listings l
join public.inventory_items i on i.id = l.inventory_item_id
where l.platform = 'ebay'
  and l.inventory_sku is not null
  and l.inventory_sku is distinct from i.sku;
```

The Foreign class is only visible in the pull's own log line, because a SKU with
no live offer produces no orphan row either: the `!o.listingId` branch resolves
no item and falls straight through to `skipped`.

## The join that fixed it (2026-09-11, US-3362)

Shipped in `doListingsPull`. No migration: 00477's index was already the right
index, and the change is which column the pass reads through.

**`buildEbaySkuIndex(items, listings)`** (exported from `flipdesk-ebay.ts`)
replaces the old `inventory_items.sku` map. It is a pure function over the two
preloads, and it claims a SKU in a fixed precedence, first writer winning:

1. `listings.inventory_sku` - what eBay is KNOWN to hold, pinned at publish.
2. `variantSku(inventory_sku, v)` for each member of `listings.variations`,
   parsed with the same `normalizeVariations` the publish path runs, so the two
   stay in lockstep.
3. `inventory_items.sku` - today's value, right until the seller edited it.
4. `deriveInventorySku(item)` - reproduces what a blank-SKU publish minted, and
   covers a listing row that predates 00477's backfill.

Rule 3 losing to rule 1 is the Renamed case and is deliberate: if item A now
carries a SKU that item B was published under, eBay still holds it for B, and
resolving it to A would mark the wrong item ended.

**Three things moved with it.**

- Both preloads (`inventory_items`, and the eBay `listings` rows) now run BEFORE
  the offer fan-out rather than after it, because the skip set that decides which
  SKUs cost a call has to be expressed in eBay's SKUs, and the index is that
  translation. `offerCheckRowsForIndex` spreads one item's
  `ebay_offer_checked_at` across every SKU the index maps to it, so a Minted or
  Variant SKU can enter the skip set at all. Same two queries as before, two
  columns wider (`inventory_sku`, `variations`), and the item query no longer
  filters `sku is not null` - a blank-SKU item is the whole point.
- The per-offer decision came out of the loop as **`routeRemoteOffer`**, which
  returns `listed | ended | orphan | skipped`. Both ended-without-sale branches
  are now that function's answer rather than two inline ternaries, which is what
  makes the path testable: it sits behind a resolved item id, so a guard that
  greps for `endedItemIds` is green for the entire lifetime of the bug.
- The US-3111 stamp is `.in("id", plan.itemIds)` via **`planOfferStamp`**, and
  the SKUs are mapped back from the returned ids for the coverage count. The
  plan's `unresolved` list is the Foreign residue and is printed as
  `offers_unresolved=` on the pull-complete line, next to `offers_read`.

One unrelated bug went with it: the modern pass wrote orphans with a hard-coded
`title: null` although `listAllOffers` already carries the title, which is why a
Reconciliation row could be nameless even for a foreign listing the legacy pass
was suppressed from re-describing.

**What to expect on prod.** `offers_unstamped` should fall to roughly
`offers_unresolved`, and US-3357's arithmetic (`1 + 3f = 1.7`) predicts about
23% of the eBay inventory list. A much smaller residue means that analysis was
wrong and the container log is the next step; the SQL in the section above
counts the Minted and Renamed halves directly.

Tests: `src/tests/ebay-sku-resolution_test.ts` (25 cases; the Minted class is
driven end to end - blank SKU in, `ended` out).

## The stamp that could not fit in a URL (2026-09-13, US-3111 AC7)

US-3111's AC7 asked for two numbers 48 hours after deploy. Reading them is what
found a live outage in the mechanism itself, so the answers come second.

### What the container log said

    [flipdesk-ebay] failed to stamp ebay_offer_checked_at: URI too long
    [flipdesk-ebay] failed to stamp ebay_specifics_checked_at: URI too long

on every catalog pass since US-3362 deployed. Kong fronts PostgREST with nginx
defaults, so the whole request line has to fit an 8 KB buffer.

**The cause is a unit mismatch, and it is the part worth remembering.** US-3111
chunked the offer stamp at 400 rows per request, which was comfortably safe -
for SKUs. `FD-1a2b3c4d` costs 14 characters with its separator, so 400 of them
is about 5,600. US-3362 then re-keyed the same stamp onto `inventory_items.id`
to fix the resolution bug in [[#The SKU eBay holds is not the SKU on the item (2026-09-11, US-3357)]].
A uuid costs 39. The row count did not move and the payload tripled to about
15,600. The `ebay_specifics_checked_at` stamp beside it was never chunked at
all and failed the same way on the same passes, at 297 ids.

> [!warning] A row count is a proxy for a limit that is measured in characters
> `chunkIdsForInFilter` packs to a CHARACTER budget (`IN_FILTER_CHAR_BUDGET`,
> 4000) rather than a row count, so the next change of key cannot re-break it.
> Its guard checks what each stamp FILTERS ON, not whether a chunker appears
> somewhere above it: the first draft looked backwards for the nearest `for (`,
> and an unchunked stamp below a chunked one borrowed its sibling's loop and
> read as budgeted. That draft is kept as a failing case in
> `ebay-stamp-url-budget_test.ts` so the guard is tested rather than merely
> green.

Neither failure was silent in the code's own terms - US-3111 AC4's fail-open
logged both and pushed them onto the run's errors. It was silent in the terms
that matter: a `console.error` in a rotating container log is not a page, and
the measurement that would have caught it was the AC nobody had run yet.

### The two numbers AC7 asked for

**Call volume, from `ebay_api_call_daily`.** The stagger works, and it kept
working through the stamp outage because the fan-out ceiling bounds a pass:

| day | GET /sell/inventory/v1/offer |
|---|---|
| 2026-09-02 | 25,021 (pre-fix) |
| 2026-09-04 | 1,614 (fix live) |
| 2026-09-07 | 1,056 |
| 2026-09-11 | 1,338 |
| 2026-09-12 | 2,242 |

Against ~984 SKUs that is roughly one read per SKU per day, which is what the
story projected. The 09-12 rise is the stamp outage showing up where it was
always going to: the skip set emptying out.

**Stuck listings - and the AC could not be run as written.** It asks that "no
listing sits in 'listed' with an ended eBay listing for more than 24 hours".
`public.listings` has `listing_status`, not `status`, and no `ended_at` at all.
The subject is the ITEM: `inventory_items.status = 'listed'`, reconciled by
`resyncItemListedStatus`, which flips to `drafted` only once NOTHING is live on
any marketplace. So the query has to mirror that rule, not the listing row:

```sql
-- Items still 'listed' with nothing live anywhere, split by whether the eBay
-- listing ever actually reached eBay. Only the second class is a stuck listing.
select l.listing_status,
       (l.platform_listing_id is not null or l.platform_offer_id is not null
        or l.synced_to_ebay_at is not null) as reached_ebay,
       count(distinct i.id) as items
from public.inventory_items i
join public.listings l on l.inventory_item_id = i.id and l.platform = 'ebay'
where i.status = 'listed'
  and not exists (select 1 from public.listings a
                  where a.inventory_item_id = i.id and a.is_active)
group by 1, 2;
```

Prod, 2026-09-13: **37 items, all of them `draft` rows that never reached eBay**,
plus one behind a `sold` listing. **Zero** sit behind an ended eBay listing, so
the AC passes - but the 37 are a real and separate defect, and reporting a bare
zero off the AC's own wording would have hidden them. There is no clock column
for "how long", because there is no `ended_at`; the nearest honest one is
`platform_fields->'ebay_state'->>'observed_at'`, which is written only on a
CHANGE and is therefore the transition time when present and absent otherwise.

Note also that during the stamp outage this answer was cheap in the wrong way:
`ended_to_draft=0` on every pass. Zero stuck items and zero detections are the
same reading when the detector is dead.

## Inbound eBay notifications are not running; polling is the real source

Measured on prod 2026-09-12/13 from the edge container log (US-3110 AC9). The
reconcile cron reports `ebay.notification_missing_buckets = 5` — **all five**
required buckets — and has done so on every run. No eBay notification reaches
FlipDesk. Every sale, payout, return and listing-end arrives through the polling
backstop and the marketplace-event sweep instead, which is why those paths carry
the whole lifecycle and why their call volume is the thing worth tuning.

The cause is eBay's, not ours. Each run POSTs a subscription per topic in a
required bucket and gets:

    403 {"errorId":195011,"domain":"API_NOTIFICATION",
         "message":"Not authorized for this topic."}

for twelve of them, including `ORDER_CONFIRMATION`, `ORDER_RETURN_ACTIVITY`,
`PRIORITY_LISTING_REVISION` and — the tell that this list is eBay's catalog and
not ours — `LOAN_APPLICATION_CANCEL`, a lending-product topic no clothing
reseller will be granted. `classifyEbayTopic` matches on substrings so the
reconcile subscribes anything eBay's catalog puts in a required bucket; that is
right for the inbound receiver and generous for the outbound decision.

**The rule: 195011 is permanent, so it is not a run failure.** No retry fixes
it — a human has to be granted the topic in the eBay developer portal, or the
bucket stays on polling. Counting it as a failure is what made this cron report
`errors:12` every six hours for 128 consecutive red runs with zero successes,
and made "eBay refuses us" indistinguishable from "our code broke".
`isTopicNotAuthorizedError` now routes those into `result.notAuthorized`, which
the cron logs as `ebay_notification.topics_not_authorized` and the admin
reconcile writes to the audit log as `not_authorized` — a record that outlives a
container restart, which the rotating log did not.

**What keeps that honest:** the run's failure count is now bucket HEALTH
(`failed: result.health.missingBuckets.length`), not the attempt log. A required
bucket with no enabled, correctly-routed subscription is still a red run. Before
this the ledger read the refusals, which happened to coincide with the pipeline
being dead but never measured it. Pinned by
`src/tests/ebay-notification-subscriptions_test.ts`.

## Related

- [[ebay-condition-and-policies]] — a rejected condition is one way a publish fails
- [[ebay-aspect-value-limit]] — the other, and its stuck-offer failure mode
- [[cross-listing]] — which marketplaces have an offer lifecycle at all
- [[INDEX]]
