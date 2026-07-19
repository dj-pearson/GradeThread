---
title: eBay 65-character aspect-value limit
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ebay-client.ts
reviewed: 2026-07-18
tags: [ebay, publishing, gotcha]
summary: eBay rejects aspect values over 65 chars at publish, not at upload - which is why the error surfaces as an unrelated "already has active offer".
---

# eBay 65-character aspect-value limit

eBay hard-rejects any item-specific (aspect) **value** longer than 65 characters.
Enforced in `ebay-client.ts` via `EBAY_ASPECT_VALUE_MAX_LEN = 65` and
`capAspectValuesForEbay()` (verified 2026-07-18, `ebay-client.ts:2186`).

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
from the number (US-528). Read the **last** `publish failed:` line in the
edge-function log and look at the message, not the code.

A single free-text aspect can permanently block a listing this way.

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
