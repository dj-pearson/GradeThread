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
value without complaint. The failure only appears later, at **publish** — so the
error surfaces far from its cause, in a different call, on a different day if the
listing sat as a draft.

Worse, the symptom is usually misleading. A failed publish leaves the offer in a
state where the retry reports **`25002` — "already has active offer"**. That error
sends you hunting for a duplicate-offer bug that does not exist, when the actual
cause is a 66-character Style value.

**Diagnostic:** read the **last** `publish failed:` line in the edge-function log.
The 25002 is downstream noise; the real reason is in the earlier failure.

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
