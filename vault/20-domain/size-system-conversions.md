---
title: Size-system conversions — four allowed, the rest refused
aliases: [size systems, size conversion, UK to US, IT sizing, EU sizing]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/size-systems.ts
  - services/edge-functions/src/lib/sizing-charts.ts
reviewed: 2026-07-31
tags: [sizing, brands, conversion, contract]
summary: Only four size-system conversions are performed, every one derived from paired data already in the corpus; EU, JP, AU and alpha are refused outright, and a refusal is the correct answer rather than a gap.
---

# Size-system conversions

The decoder bar ([[brand-kb-decoder-bar]]) applied to sizing. A wrong conversion
is worse than none, because it puts a confident, plausible, wrong size on a
public certificate — and unlike a wrong brand, nobody looking at the garment can
tell.

## The shape gap this closed (US-2215)

`SizingChart` had `department` and a free-text `garment` scope and **nowhere to
say which national system a label is written in**. So the corpus encoded it the
only way it could: inside the label. **115 of 292 charts** do this —
`UK 10 (US 6)`, `IT 48 (US 38)`, `FR 36 (US 4)`, `JP L (≈US M)`. Every one of
those parentheses was a workaround for a missing field.

`size_system` and `size_class` now exist as columns. **The prose was kept** — the
size labels and notes are what the model actually reads, and re-authoring 115 of
them is a separate change that deserves its own eval.

## The four allowed conversions

Derived from the corpus, not recalled. Every label stating both sides was
extracted and the offsets checked for contradictions:

| System | Department | Offset | Points | Contradictions |
|---|---|---|---|---|
| FR | Women | +32 | 6 | 0 |
| IT | Men | +10 | 6 | 0 |
| IT | Women | +36 | 6 | 0 |
| UK | Women | +4 | 6 | 0 |

A test re-derives all four from `SIZING_CHARTS` and fails if the corpus stops
agreeing, so the table cannot drift away from its own evidence. A second test
fails if a conversion is added with **no** paired data behind it.

## The refusals, and why each is correct

- **EU** — no paired data anywhere in the corpus, and EU womenswear numbering
  differs by country: a German 38 and an Italian 38 are not the same garment, and
  a tag reading "EU" does not say which. Refused.
- **JP** — the corpus's only JP mapping is BAPE's, and `00456` records it as a
  **brand** fact: BAPE runs small, so "JP L ≈ US M" is true of BAPE and not of
  Japan. Generalising it would mis-size every other Japanese label.
- **AU** — no data.
- **alpha → alpha** — S/M/L is not a numbering system. Essentials' "M drapes like
  a US L" is a **design** fact (`00456`), not a conversion.
- **UK/FR men's** — no paired data. UK men's tailoring often equals US, and
  "often" is not a rule the corpus vouches for.
- **Any result ≤ 0** — an offset that produces "US 0" has been applied outside
  the range it was derived from, which is inventing a size.

A refusal returns `null`, meaning *we do not know*. The caller shows the original
label. **Null is never rendered as a converted size.**

## Detection reads; it does not guess

`detectSizeSystem` returns a system only when the labels say so. A chart of bare
numbers stays **null** — a bare "6" could be US or UK and nothing in the row
says which — and null means "not recorded", never an implied US. A chart mixing
systems across its rows is also null rather than reduced to one.

## Extended sizing exists as a dimension, not as data

`size_class` (plus / petite / tall / big_and_tall / maternity) is now
representable. It is **almost entirely unpopulated, and that is accurate**: the
corpus contains exactly ONE extended chart — Talbots, whose scope reads
"Misses (US 2-18) / Petite (0P-16P) / Plus (14W-26W)". That one chart is the
folding this dimension exists to end, so it resolves to `null` rather than being
collapsed to a single class that would be false for two thirds of its rows.

Seeding real plus/petite/tall charts is a **sourcing** project, like the RN
coverage gap in [[brand-kb-negative-findings]]. The dimension is the
prerequisite, not the deliverable.

## Related

- [[brand-kb-decoder-bar]] — the discipline this note applies to sizing.
- [[brand-kb-negative-findings]] — the other place absence is recorded as correct.
