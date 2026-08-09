---
title: The same photograph, a cheap fix or a dead item
aliases: [consumable vs terminal, replaceable wear, DWR, seam tape, spikes]
type: reference
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00582_western_brand_knowledge.sql
  - supabase/migrations/00583_golf_brand_knowledge.sql
  - supabase/migrations/00584_snow_outerwear_brand_knowledge.sql
reviewed: 2026-08-09
tags: [grading, condition, categories]
summary: In several categories the visible wear is a part the next owner replaces for pennies, while the failure that actually ends the item is invisible — so the grade depends on knowing which one you are looking at.
---

# The same photograph, a cheap fix or a dead item

A recurring shape, found three times in one day across unrelated categories and
worth stating once rather than rediscovering per pack:

> **The wear you can see is often a CONSUMABLE. The failure that ends the item is
> usually invisible in a photograph.**

A condition rubric that grades what is visible therefore gets these categories
backwards — marking an item down for something replaceable while missing the
thing that finished it.

## The three pairs

| category | consumable (cheap to fix) | terminal (unrecoverable) |
|---|---|---|
| **Western boots** (`00582`) | a worn sole on a **welted** boot — it can be resoled | the same wear on a **cemented** boot — it cannot |
| **Golf shoes** (`00583`) | worn or missing **soft spikes** — they screw out | stripped **spike receptacles** — no new spike will hold |
| **Snow outerwear** (`00584`) | **DWR** wearing off — re-treatable for a few pounds | **seam tape** delaminating — cannot be restored |

In each row the two states can look identical in a listing photo, and in each the
difference is most of the price.

## What this means for the seeded guidance

1. **Name both sides.** A tell that only says "this is not damage" leaves the
   grader blind; it has to say what *is*. Every pack above names the consumable
   **and** the failure it is often confused with.
2. **Give an inspection instruction, not a warning.** The useful sentence is
   physical: *turn the jacket inside out and photograph the tape over the
   shoulder and underarm seams.* That is the highest-value photo in snow
   outerwear and almost nobody takes it.
3. **Say when it does not apply.** A spikeless golf shoe has no receptacles to
   strip; a Volcom t-shirt has no seam tape. Guidance that fires on the wrong
   garment is worse than none.

## Related

- [[small-leather-goods]] — patina as design rather than wear, a neighbouring inversion
- [[uniform-and-scrubs]] — the opposite case, where the visible damage genuinely is terminal
- [[brand-kb-negative-findings]] — the vintage-tee inversion, where the wear is the product
- [[grading-scale-and-weights]] — what consumes the tells
