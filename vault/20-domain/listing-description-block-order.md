---
title: Listing description block order
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/description-blocks.ts
  - services/edge-functions/src/lib/platform-description.ts
  - services/edge-functions/src/lib/listing-grounding.ts
  - services/edge-functions/src/lib/listing-voice-presets.ts
  - src/lib/description-blocks.ts
reviewed: 2026-09-21
tags: [flipdesk, listings, descriptions, ai]
summary: The order a new listing description renders in, why the facts come before the prose, and what the prose is not allowed to claim.
---

# Listing description block order

A description is an ordered list of named blocks. A block either STORES text
(`intro`, `features`, `condition`, `text`, `snippet`) or DERIVES it
(`attributes`, `measurements`, `grade`, `disclosure`, `credentials`, `facts`).
The mechanics are in `description-blocks.ts`; this note owns the ORDER and the
rules about what may be said.

## The order, for a NEW description

1. `attributes` — brand, size, color, material, from the item row
2. `condition` — derived from the grade when the item has one, else AI prose
3. `measurements`
4. `disclosure` — the flaw list, grade-backed
5. `intro` — AI prose
6. `features` — AI prose
7. `grade` — off by default
8. `credentials`
9. `facts` — always emitted last

`defaultBlocks()` in `description-blocks.ts` is authoritative.
`DEFAULT_DESCRIPTION_BLOCKS` in `src/lib/description-blocks.ts` mirrors it so
the composer can draw rows before the first save;
`src/test/description-block-parity.test.ts` fails if the two drift.

## Why facts come first (US-3211)

Buyers say an AI description is a reason to skip a listing and grounds for a
return. Three r/Ebay threads with 900+ combined upvotes are quoted in
[[forum-sentiment]] section 8, and the ranked recommendation is row 9 of
[[competitor-landscape-2026-09]]. Until US-3211 the default put `intro` and
`features` at the top, so the first thing a buyer read was the part they
distrust.

## Existing listings are never reordered

`defaultBlocks()` is the default for a NEW description. A listing already in
the wild keeps the order its blocks are stored in. Reordering on open would
rewrite the description of every listing a seller merely LOOKED at — the same
reason each block carries its own `sep` bytes rather than a normalised
separator.

## Every channel gets the same order

`platformDescriptionBlocks()` filters and substitutes; it does not reorder.
The one exception is a listing whose `intro` block was deleted, where the
platform's prose has nowhere to go: it is inserted after the derived fact
blocks rather than at the top, so a seller cannot get facts-first on eBay and
prose-first on Poshmark.

## What the prose may not claim

`listing-grounding.ts` runs the generated `intro` and `features` through a
grounding check before they are stored or returned. Any material, fibre, size,
brand, era or country-of-origin token that is absent from the item row, the
tag OCR in `inventory_items.ai_field_sources` and the grade report causes its
SENTENCE to be dropped, and what went is reported to the caller.

Two properties are deliberate:

- **The vocabulary is closed.** Fibres, eras and brands come from fixed lists
  (the brand list is the `brandMatch` tokens already compiled into
  `sizing-charts.ts`). Asking a model whether a claim is grounded would be a
  second unverifiable opinion about the first one. What a closed list cannot
  do is catch a claim phrased in words nobody listed, so this is a floor.
- **It drops the sentence, not the word.** Removing "linen" from "linen blend
  construction" leaves prose that still asserts something and reads broken.

Brand tokens shorter than four characters are never matched on their own. The
sizing corpus holds `alo` for Alo Yoga, and a substring match turns "also"
into a brand claim; the same trap cost US-3319 a whole story with a bare
`duluth` token.

## The default voice

A `flipdesk_settings.listing_voice_prompt` that has never been set resolves to
the **Plain facts** preset (`listing-voice-presets.ts`), not to nothing. An
empty box is not neutral when the fallback is the register buyers complain
about. A seller who wants the pre-preset wording selects **Standard**, which
stores a sentinel and resolves to null.
