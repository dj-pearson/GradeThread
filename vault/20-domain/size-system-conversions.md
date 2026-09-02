---
title: Size-system conversions — four allowed, the rest refused
aliases: [size systems, size conversion, UK to US, IT sizing, EU sizing]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/size-systems.ts
  - services/edge-functions/src/lib/grading-size.ts
  - services/edge-functions/src/lib/sizing-charts.ts
reviewed: 2026-09-02
tags: [sizing, brands, conversion, contract]
summary: Only four size-system conversions are performed, every one derived from paired data already in the corpus; EU, JP, AU and alpha are refused outright, and a refusal is the correct answer rather than a gap.
---

# Size-system conversions

> **Re-reviewed 2026-09-02.** Drift flagged `size-systems.ts` for US-3033, which
> adds `normalizeSizeLabel` -- the join key for the Fit & Measurement Index. It
> is a COHORT key, not a conversion: it folds "W34 L32", "34x32" and "34X32" onto
> one label so a style-and-size cohort clears its sample floor instead of
> splitting three ways. The conversion tables below are untouched, and the two
> must not be confused: normalization decides what counts as the same size,
> conversion decides what a size means in another system.


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

## From a chart row to a size label (US-2215, wired 2026-08-17)

Everything above converts a chart **row**, whose system is known because the
chart declares it. A certificate has no chart — it has one size **string** a tag
pass transcribed. Until this was wired, `size-systems.ts` was imported by nothing
in production: the dimension and the four conversions had shipped and no surface
called them.

Three functions carry a label rather than a row:

| Function | Answers | Refuses when |
|---|---|---|
| `normalizeDepartment` | `Women` / `Men` | Unisex, Kids, Baby, anything unrecognised — no corpus-backed offset exists |
| `systemFromLabel` | the system an explicit two-letter prefix names | a bare number, an alpha size, `W30 L32`, a token not on the allowlist |
| `usEquivalentForLabel` | the US number | any of the above, already-US, a value below the offset, **or a label that already states its own US equivalent** |

That last refusal is specific to this corpus: 115 of 292 charts embed the
equivalence inside the label because there was nowhere structured to put it, and
appending a second copy is noise. **Noise on a certificate is indistinguishable
from a bug.**

It renders through `sizeVerificationLine` in `grading-size.ts`, the line US-2213
already uses for the verified size, so the conversion inherits that trusted-block
discipline instead of getting a path of its own. When it refuses, the line is
**byte-identical** to what it was before this shipped — asserted by string
equality over eight refused shapes, not by resemblance.

## Extended sizing exists as a dimension, not as data

`size_class` (plus / petite / tall / big_and_tall / maternity) is now
representable. It is **almost entirely unpopulated, and that is accurate**: the
corpus contains exactly ONE extended chart — Talbots, whose scope reads
"Misses (US 2-18) / Petite (0P-16P) / Plus (14W-26W)". That one chart is the
folding this dimension exists to end, so it resolves to `null` rather than being
collapsed to a single class that would be false for two thirds of its rows.

Seeding real plus/petite/tall charts is a **sourcing** project, like the RN
coverage gap in [[brand-kb-negative-findings]]. The dimension is the
prerequisite, not the deliverable — and since 2026-08-17 the reading half above
exists, so a chart added tomorrow is *read* rather than stored.

## Related

- [[brand-kb-sizing-units]] — the neighbouring question: the same system, but two brands printing different measurements under one label

- [[brand-kb-decoder-bar]] — the discipline this note applies to sizing.
- [[brand-kb-negative-findings]] — the other place absence is recorded as correct.
