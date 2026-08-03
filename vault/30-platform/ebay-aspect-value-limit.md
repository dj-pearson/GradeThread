---
title: eBay 65-character aspect-value limit
aliases: [25002, aspect too long, 65 char]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ebay-client.ts
reviewed: 2026-08-03
tags: [ebay, publishing, gotcha]
summary: eBay rejects aspect values over 65 chars at publish, not at upload - which is why the error surfaces as an unrelated "already has active offer".
---

# eBay 65-character aspect-value limit

eBay hard-rejects any item-specific (aspect) **value** longer than 65 characters.
Enforced in `ebay-client.ts` via `EBAY_ASPECT_VALUE_MAX_LEN = 65` and
`capAspectValuesForEbay()` (verified 2026-08-01, `ebay-client.ts:2224`).

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

`isOfferAlreadyExistsError` handles the ambiguity by requiring **both** the id
*and* `/already exists/i` in the message. **Do not loosen that to an id-only
check** — it would classify every over-long-aspect failure as a duplicate offer.

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

It is applied at a **shared chokepoint** in the inventory-item payload builder, so
every publish path inherits it. New publish paths should route through that same
builder rather than constructing aspect maps directly.

## Related

- [[INDEX]]
- More eBay integration knowledge lands here in US-2053.
