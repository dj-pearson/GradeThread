---
title: A size label belongs to the brand that printed it
aliases: [sizing units, hat sizes, size conversion]
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00574_headwear_brand_knowledge.sql
  - supabase/migrations/00575_eyewear_brand_knowledge.sql
  - supabase/migrations/00576_jewelry_brand_knowledge.sql
  - supabase/migrations/00581_tailoring_formalwear_brand_knowledge.sql
  - supabase/migrations/00582_western_brand_knowledge.sql
  - supabase/migrations/00583_golf_brand_knowledge.sql
  - services/edge-functions/src/tests/headwear-content_test.ts
reviewed: 2026-08-09
tags: [brands, sizing, contract]
summary: Two brands print different inches for the same hat size, so a size label may never be converted from one maker into another's — each chart is seeded under its own brand_key and read only there.
---

# A size label belongs to the brand that printed it

`brand_size_charts` holds one chart per `(brand_key, department, garment)`. The
reason it is keyed by brand — rather than one shared chart with brand overrides —
is not tidiness. **Brands publish different measurements for the same printed
label**, and the difference is large enough to change a fit.

## The measured case

Headwear (`00574`, US-2221) is where this stopped being theoretical, because hat
sizes *look* like a universal unit: a hat size is head circumference in inches
divided by pi, which is arithmetic, not a brand's opinion. Both charts below are
the brands' own published ones:

| Printed size | New Era | Stetson | Arithmetic (size × π) |
|---|---|---|---|
| 7 1/4 | 22 3/4 in | 23 in | 22.78 in |
| 7 1/2 | 23 1/2 in | 23 3/4 in | 23.56 in |

New Era states the circumference. **Stetson rounds up**, consistently, and its
own guidance says why: *order a size up if you are between sizes.* Stetson
publishes a **fit** chart, not a conversion table.

So the same "7 1/4" means up to a **quarter inch** more head depending on who
printed it. That is a size band, not a rounding artefact.

## The rule

> **Never convert a size label from one brand into another brand's label.**
> Resolve a chart by `brand_key`, read the measurement, and stop. If no chart
> exists for that brand, say the size is unconverted — do not borrow a neighbour's.

Two corollaries that have already caught mistakes:

- **Alpha bands are not one size.** Kangol's `L` spans two hat sizes (7 1/4–7 3/8);
  Goorin Bros.' `L` is a single one (7 3/8). Writing either into a field that
  expects one number loses information in one case and invents precision in the
  other.
- **A fit that is not fitted has no hat size at all.** A 39THIRTY stretch-fit or
  a 9FIFTY snapback is published only as an overall span, so those charts are
  seeded as spans. Converting a snapback's `S-M` into a fitted 7 1/4 is inventing
  a measurement the maker never made.

## The inverse case: eyewear needs no chart at all

Added 2026-08-09 with the eyewear pack (`00575`). It is the same category of
product — an accessory worn on the head — and it behaves the opposite way, which
is what makes the rule above about *labels* rather than about hats.

A frame carries its own measurements, imprinted on the inside of the temple:
**lens width, bridge width, temple length, in millimetres** (`58□14 135`). That
format is an industry standard, not a brand's scheme, so:

- there is nothing to look up, and `00575` seeds **no size chart at all** — a
  seeded one would be invented;
- the numbers *are* comparable across brands, because they are measurements
  rather than labels;
- and for the same reason the triplet is **useless as brand evidence** — every
  maker prints it. It is refused as a decoder in [[brand-kb-decoder-bar]].

So: **a hat's size is a brand's label and cannot be converted; a frame's size is
a measurement and needs no conversion.** The dividing question is not the
category, it is whether the number on the item is a measurement or a name for
one.

Jewelry (`00576`) is the third data point and lands on the same side as eyewear:
a US ring size is a standard, a bracelet is sold in centimetres, and neither is a
brand's scheme. **No chart is seeded there either.** Three accessory categories,
and only headwear needs charts — which is the evidence that this rule is about
labels rather than about any particular kind of product.

## Tailoring: one category, three systems, and a subtraction

Added 2026-08-09 with `00581` (US-2220 AC3). The strongest case in the corpus for
the rule at the top of this note, because tailoring does not have *a* sizing
system — it has three at once, and one of them is not on the label at all.

> **A suit size is two garments and a subtraction.**

`40R` is a 40-inch **jacket chest** in **Regular** length. It says nothing about
the trouser waist. That comes from the **drop** — jacket chest minus trouser
waist — and the drop is a property of the **maker's cut**:

| drop | 40 chest → trouser waist | who it is cut for |
|---|---|---|
| 4-drop | 36 | fuller build |
| **6-drop** | **34** | the US off-the-rack default |
| 8-drop | 32 | athletic build |

So the same printed `40R` is a 32, a 34 or a 36 waist depending on who made it.
**A listing that gives the label without the measured waist has not given the
trouser size.**

The **length letter** is a third axis and it moves length and sleeve, *never*
chest: a 40S, 40R and 40L all fit a 40-inch chest, with L adding roughly 1.5
inches of jacket length and sleeve over R. And a **dress shirt** is neck × sleeve
in half-inch neck increments — a fourth shape again, which collapsing to alpha
destroys.

Three charts are seeded for this reason, under the generic key
`tailoringmenswear`. That is a deliberate exception to "keyed by brand": the
chest run and the drop arithmetic are an **industry convention** rather than any
house's label, unlike hat sizes where two makers genuinely print different inches
for the same printed size. `00389`'s own `genericmensalpha` keys are the
precedent. A house that departs from the convention gets its own chart, which
overrides.

### ⚠ And in this category the label is often a lie

Tailored clothing is altered — waist suppressed, sleeves shortened, trousers
hemmed — and **the tag never changes**. So tailoring depends on measurement more
than any category here.

The same fact from the other side is worth money: unused **inlay** (let-out room
in the seams and waistband) is what lets the next owner have it fitted, so a suit
that has never been altered is worth more than one that has.

## Western boots: a second axis, and two brands that cancel out

Added 2026-08-09 with `00582` (US-2220). Footwear resale normally ignores width —
a sneaker is listed as "10" and nobody asks. **A western boot is sized on two
axes**, and the second one is on the box:

`B` narrow · `D` medium (the men's default) · `EE` wide · `EEE` extra wide
(Justin prints `EEE` as `XW`).

**A boot listed without its width has been half-sized**, and the buyer cannot
infer it: a D and an EEE in the same length are different boots.

The chart seeds the letters as a **rank, not a measurement** — no maker publishes
the width in inches, and inventing one would be exactly the false precision this
note exists to prevent.

### ⚠ And the letter is brand-relative, in opposite directions

| brand | length | width |
|---|---|---|
| **Ariat** | runs ~½ size **small** | fits **broad** |
| **Lucchese** | runs ~½ size **large** | runs **narrow** — its D is reported to fit like another maker's B or C |

Two houses, offsets pointing opposite ways. So a Lucchese D and an Ariat D are
not the same width *and* the same printed length is two different boots. **A
width letter must never be converted between brands** — the rule at the top of
this note, arriving in footwear.

Those offsets are seeded as **tells rather than charts**, deliberately: they are
consistent across the retail channel but no maker publishes a numeric conversion,
so a chart would give them a precision the sourcing does not support. Directional
guidance plus *measure the insole* is the honest form.

### ⚠ And golf shoes use a DIFFERENT width alphabet

Added with `00583`. Footwear width turned out not to be one system either:

| category | letters |
|---|---|
| western boots (`00582`) | `B` · `D` · `EE` · `EEE` |
| golf shoes (`00583`) | `N` · `M` · `W` · `XW` |

Same idea, different alphabets. **A boot `EE` is not a golf `W`**, and nothing
may convert between them — a test asserts no boot letter appears in the golf
chart. Both are seeded as **ranks, not measurements**, because no maker publishes
either width in inches.

## Why this is a contract and not a comment

The tempting "cleanup" is to notice that two brands disagree and reconcile them.
`headwear-content_test.ts` asserts the disagreement directly — both numbers, plus
a negative assertion that New Era's chart does **not** carry Stetson's value — so
reconciling them reddens a test that says why in its message. A rule that only
lives in prose gets tidied away by the next reader who assumes a hat size is a
hat size.

## Related

- [[brand-taxonomy-overview]] — why per-brand values live in the DB and per-corpus rules live here
- [[brand-kb-decoder-bar]] — the same discipline applied to codes rather than sizes
- [[brand-kb-negative-findings]] — traps recorded so they are not re-introduced
- [[size-system-conversions]] — the neighbouring question: converting between size SYSTEMS (UK/IT/US), not between brands
- [[small-leather-goods]] — a category where the number on the item means nothing at all
- [[restricted-materials]] — the other thing a western boot listing must get right
- [[the-graphic-is-not-the-brand]] — the other field these categories keep getting wrong
