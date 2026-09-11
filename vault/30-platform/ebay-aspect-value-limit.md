---
title: eBay 65-character aspect-value limit
aliases: [25002, aspect too long, 65 char]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ebay-client.ts
reviewed: 2026-09-11
tags: [ebay, publishing, gotcha]
summary: eBay rejects aspect values over 65 chars at publish, not at upload - which is why the error surfaces as an unrelated "already has active offer".
---

# eBay 65-character aspect-value limit

> **Re-reviewed 2026-09-11.** Drift flagged `ebay-client.ts` for `7a28175a6`
> (US-2790). The whole diff is 169 INSERTIONS and zero deletions, in two
> places: six import lines near `:33`, and one block appended after
> `InventoryItemPayload` carrying `EbayPackageWeightAndSize`,
> `packageDimensionsFrom` and `packageWeightAndSizeForPublish`, all gated on
> `EBAY_PACKAGE_WEIGHT_AND_SIZE`, which is unset everywhere. Nothing about
> aspect values was touched and nothing this note asserts changed. The line
> refs MOVED and are corrected rather than left to drift a second time:
> `EBAY_ASPECT_VALUE_MAX_LEN = 65` is at `:2855` (was `:2686`) and
> `capAspectValuesForEbay` at `:2876`. The insertion landed at `:2678`, above
> both, which is why they moved by more than the six import lines.

> **Re-reviewed 2026-09-10.** Drift flagged `ebay-client.ts` for `a54057305`
> (US-3265 creates the three business policies a first-time seller has none of:
> `FLIPDESK_POLICY_NAME`, `PolicyAnswers`, `createDefaultPolicies`, all added as
> one block at `:2487`), `7e79a2015` (US-3196 carries `product.imageUrls` through
> `RemoteOffer`/`RemoteInventoryItem` so the sync can mirror listing photos) and
> `a97f06164` (`shipByDate` on `RemoteOrderLineItem`). EIGHTH time this file has
> tripped the guard, and none of the three hunks touches aspect validation. The
> rule is unchanged. **Every line number below was stale and is now corrected**
> against HEAD, mostly because `a54057305` inserted 168 lines above them:
> `EBAY_ASPECT_VALUE_MAX_LEN = 65` is at `:2686`, `capAspectValuesForEbay` at
> `:2707`, `isOfferAlreadyExistsError` at `:2848`, and
> `createOrReplaceInventoryItemGroup` at `:3606`. One reference was wrong about
> the FILE, not just the line: the offers lookup that re-throws lives in
> `publishItemForOwner`, which is in `routes/flipdesk-ebay.ts`, never in
> `ebay-client.ts`.

> **Re-reviewed 2026-09-03.** Drift flagged `ebay-client.ts` for `57eff0f03`
> (the offer-absent 404 in `listOffersForSku` now returns an empty list instead
> of logging an error) and `f9144c69a` (the US-3098 Browse sourcing filters:
> price with its required `priceCurrency`, buying options, several condition
> ids, free shipping, sort). SEVENTH time this file has tripped the guard and
> neither hunk is near the aspect limit. `EBAY_ASPECT_VALUE_MAX_LEN = 65` is
> still at `ebay-client.ts:2501` and `capAspectValuesForEbay` is unchanged.

> **Re-reviewed 2026-09-02.** Drift flagged `ebay-client.ts` for the size
> enforcement work (US-9200s): the category-aspect cache TTL fell from 30 days to
> 7 and `getCategoryAspects` gained a `{ fresh: true }` bypass plus
> `invalidateCategoryAspects`, so a rejection can refetch rather than re-read a
> stale answer. SIXTH time this file has tripped the guard, and the first time
> the change is in the same neighbourhood as this note. The 65-character rule is
> untouched: `EBAY_ASPECT_VALUE_MAX_LEN = 65` and `capAspectValuesForEbay` still
> do exactly what is described below, and truncation still prefers a word
> boundary. A shorter TTL only changes how fresh the ALLOWED VALUES are, never
> how long a value may be.
>
> **Re-reviewed 2026-08-31.** Drift flagged `ebay-client.ts` for `fb9de8279`,
> which coerces eBay ids that arrive as numbers. It is one additive hunk at the
> end of the file — the `ebayId()` helper — and the callers it fixes are the
> post-order modules (inquiries, cases, disputes, returns). `git show` over the
> diff contains the word `aspect` zero times. FIFTH time this file has tripped
> the guard on something unrelated, for the reason given below. Re-verified
> while here: `EBAY_ASPECT_VALUE_MAX_LEN = 65` at `ebay-client.ts:2411` and
> `capAspectValuesForEbay` at `:2432`, both moved down by intervening work, and
> the truncation still prefers a word boundary.

> **Re-reviewed 2026-08-23.** Drift flagged `ebay-client.ts` for `57fb8a64e`,
> which stops a seller being emailed their own outgoing offer with an Accept
> button. That commit adds `getEbayAccountHandle()` and rewrites the
> best-offer parse; `git show` over the diff contains the word `aspect` zero
> times. FOURTH time this file has tripped the guard on something unrelated,
> for the reason given below. Re-verified while here:
> `EBAY_ASPECT_VALUE_MAX_LEN = 65` is still the constant, at
> `ebay-client.ts:2326`, and the truncation still prefers a word boundary.

> **Re-reviewed 2026-08-21.** Drift flagged `ebay-client.ts` for `3ca575882`,
> which teaches the comp mappers to keep the categories eBay files a listing
> under. `git show` over that diff contains the word `aspect` **zero** times.
> Third time this file has tripped the guard on something unrelated, for the
> reason given below. Re-verified while here: the constant is now at
> `ebay-client.ts:2307` and `capAspectValuesForEbay` at `:2328` — both moved by
> six lines and are otherwise unchanged, and this note said 2301/2322.

> **Re-reviewed 2026-08-20.** Drift flagged `ebay-client.ts` again, for
> `5f542210`. That commit extracts title tokenisation into `title-tokens.ts`
> for the style-code market sweep: `git log -p` over it contains the word
> `aspect` ZERO times. Same verdict as the 2026-08-17 re-review below, and for
> the same reason - this file is large and busy, so it trips the drift guard on
> changes that have nothing to do with aspect validation. The 65-character rule
> and the 25002-at-publish behaviour are untouched.

> **Re-reviewed 2026-08-17.** Drift flagged `ebay-client.ts` for `b25e7650`,
> which made the relist workflow verify eBay actually acted instead of inferring
> it. That is the lifecycle verbs, not aspect validation: the 65-character
> publish-time limit and the misleading "already exists" error it surfaces as
> are unchanged.

eBay hard-rejects any item-specific (aspect) **value** longer than 65 characters.
Enforced in `ebay-client.ts` via `EBAY_ASPECT_VALUE_MAX_LEN = 65` and
`capAspectValuesForEbay()` (verified 2026-09-10: the constant at
`ebay-client.ts:2686`, the function at `ebay-client.ts:2707`).

## Why this is worth a note rather than a comment

**The rejection is deferred.** The `inventory_item` PUT accepts the over-long
value without complaint. The failure only appears at **publish** — so the error
surfaces far from its cause, in a different call, on a different day if the
listing sat as a draft.

**And `25002` means two different things.** Verified in `ebay-client.ts`
2026-07-19:

1. The over-long aspect value itself fails publish with **errorId 25002**
   ("…value of '…' is too long. Enter a value of no more than 65 characters.").
2. That failed publish leaves a **stuck unpublished offer**, so every subsequent
   retry also fails with **errorId 25002** — this time meaning "offer already
   exists".

So the id alone cannot tell you which you are looking at, and the second reading
is the one you hit while debugging. It sends you hunting for a duplicate-offer
bug that does not exist, when the real cause was a 66-character "Garment Care"
value on the first attempt.

**Disambiguate by message, not by id.** `ebayFetch` parses eBay's structured
error array into `err.ebayErrorIds` *and* `err.ebayErrorMessages`, keeping eBay's
own human text precisely because overloaded ids like 25002 cannot be resolved
from the number (US-528). Read the **last** `[flipdesk-ebay] publish failed:`
line in the edge-function log and look at the message, not the code — the
user-facing "active offer" message hides the real one.

> [!warning] This note described a safeguard that does not exist (corrected 2026-08-08)
> It said `isOfferAlreadyExistsError` requires **both** the id and
> `/already exists/i`, and warned against loosening it to an id-only check. The
> code has been the opposite since US-528 (2026-06-03): errorId 25002 **alone**
> returns true, and the message heuristic is only a fallback for non-JSON error
> bodies (`ebay-client.ts:2856`). So the note prescribed a guard nobody wrote and
> warned against the behaviour that was already shipping. It was mis-recorded at
> the note's first review, not broken by a later change.

`isOfferAlreadyExistsError` treats **errorId 25002 alone as sufficient**; the
message test (`/already exists/i` **and** `/offer/i`) only runs when the id is
missing. Because 25002 is overloaded, an over-long-aspect failure IS classified
as "offer already exists". That false positive is deliberate and safe at the call
site: `publishItemForOwner` looks up the SKU's offers and re-throws the original
error when it finds none (`flipdesk-ebay.ts:10707-10710`). What you cannot do is use
this predicate to tell the two meanings of 25002 apart — read
`err.ebayErrorMessages` for that.

A single free-text aspect can permanently block a listing this way.

## A stuck offer self-heals on retry

Once the cap is deployed, a previously stuck listing recovers without manual
intervention: step 2 re-PUTs the capped aspects, step 3 adopts the existing
offer rather than creating a second one, and step 4 publishes successfully.

The cap is **send-time only**. Stored `ebay_aspects` and `item_specifics_override`
keep the full untruncated value, so nothing is lost locally — only what eBay
receives is shortened.

## How it is handled

`capAspectValuesForEbay()` caps each value at 65 characters, preferring a word
boundary so values do not truncate mid-word into garbage, and falling back to a
hard cut only when the first 65 characters contain no break. Trailing separators
are stripped.

It is applied inside `createOrReplaceInventoryItem` (`ebay-client.ts:2737`), the
PUT that every single-item publish and revise path shares, on a shallow copy so
the caller's own map is untouched.

**One gap:** `createOrReplaceInventoryItemGroup` (`ebay-client.ts:3606`) sends
group-level `aspects` **uncapped**, so a multi-variation listing can still be
blocked by an over-long shared aspect. The variant SKUs themselves are safe —
they go through `createOrReplaceInventoryItem`. New publish paths should route
through that function rather than constructing aspect maps directly.

## Related

- [[INDEX]]
- More eBay integration knowledge lands here in US-2053.
