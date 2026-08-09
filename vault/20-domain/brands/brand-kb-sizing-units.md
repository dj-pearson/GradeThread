---
title: A size label belongs to the brand that printed it
aliases: [sizing units, hat sizes, size conversion]
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00574_headwear_brand_knowledge.sql
  - supabase/migrations/00575_eyewear_brand_knowledge.sql
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
