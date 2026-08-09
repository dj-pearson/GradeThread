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
  - supabase/migrations/00585_swim_brand_knowledge.sql
reviewed: 2026-08-09
tags: [grading, condition, categories]
summary: In several categories the visible wear is a part the next owner replaces for pennies, while the failure that actually ends the item is invisible — and in swimwear there is no visible signal at all, so the care label beats the photographs.
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

## The limit case: swimwear, where there is no visible signal at all

Added with `00585`. The three pairs above each have *something* to look at. Swim
does not, and that makes it the sharpest version of the problem.

**Chlorine attacks the elastane first.** The suit loses recovery, then sags and
goes translucent — with no stain, no tear and no fade. A non-resistant suit can
lose most of its tensile strength inside a few hundred hours of pool time, which
for a swimmer training regularly is one season. **A competition suit can be
functionally spent while photographing perfectly.**

So there is no consumable half here. The whole failure is invisible, and the only
usable predictor is somewhere unusual:

> **The care label beats the photographs.** Fibre content ranks expected life and
> it is printed: PBT/polyester blends last longest, polyester-spandex is close
> behind, nylon-spandex breaks down fastest.

That is the one category in the corpus where reading the composition *before*
looking at the images is the correct order. The seeded tells also name what the
failure looks like when it finally shows — no spring-back at the leg openings,
see-through when stretched — because removing a signal without replacing it just
leaves the grader blind.

### And a gate that is not about condition at all

Swim bottoms ship with a disposable **hygienic liner**, and return and
consignment policies across the trade commonly require it intact with the
original tags. Whether it is present can decide **whether the item may be listed**
— before anyone discusses condition.

The pack **records** the liner and **refuses to adjudicate** any particular
marketplace's rule, because policies differ and change. Same discipline as the
CITES tell in [[restricted-materials]]: flag it, name where the real answer
lives, and do not answer it yourself.

## Related

- [[small-leather-goods]] — patina as design rather than wear, a neighbouring inversion
- [[uniform-and-scrubs]] — the opposite case, where the visible damage genuinely is terminal
- [[brand-kb-negative-findings]] — the vintage-tee inversion, where the wear is the product
- [[grading-scale-and-weights]] — what consumes the tells
