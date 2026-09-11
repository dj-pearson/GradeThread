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
reviewed: 2026-09-11
tags: [sizing, brands, conversion, contract]
summary: Only four size-system conversions are performed, every one derived from paired data already in the corpus; EU, JP, AU and alpha are refused outright, and a refusal is the correct answer rather than a gap.
---

# Size-system conversions

> **Re-reviewed 2026-09-10.** The US-3294/3297/3298 batches closed the backfill
> and took the corpus from 292 charts to 415. The contract is unchanged: still
> four conversions, still the same four offsets, still zero contradictions, and
> still no paired EU/JP/AU data anywhere. Three counts in this note WERE stale
> and are corrected below: the size-label census (now 127 of 415), the evidence
> points behind two of the four offsets, and the extended-sizing section, which
> claimed Talbots was the only extended chart. It is not, and has not been for
> several batches: there are nine now.
>
> **Re-reviewed 2026-09-09.** Drift flagged `sizing-charts.ts` for the US-3283
> backfill loop, which appends brand charts. Two of them are size-system charts
> and neither changes the contract below: Herno publishes an IT-to-US/UK/FR/DE/JP
> conversion with NO body measurements at all, so it is stored as the brand's own
> printed conversion rather than as anything this module derives. That is the
> rule working — the conversion is the BRAND's, read off the brand's page, not
> one we computed. See [[size-chart-coverage-backfill]].
>
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
only way it could: inside the label. **127 of 415 charts** do this (115 of 292
when the story shipped; the backfill batches keep adding to the pile) —
`UK 10 (US 6)`, `IT 48 (US 38)`, `FR 36 (US 4)`, `JP L (≈US M)`. Every one of
those parentheses was a workaround for a missing field.

`size_system` and `size_class` now exist as columns. **The prose was kept** — the
size labels and notes are what the model actually reads, and re-authoring 127 of
them is a separate change that deserves its own eval.

## The four allowed conversions

Derived from the corpus, not recalled. Every label stating both sides was
extracted and the offsets checked for contradictions:

| System | Department | Offset | Points | Contradictions |
|---|---|---|---|---|
| FR | Women | +32 | 18 | 0 |
| IT | Men | +10 | 12 | 0 |
| IT | Women | +36 | 6 | 0 |
| UK | Women | +4 | 6 | 0 |

Points is a census of the corpus at 415 charts, re-counted 2026-09-10. It only
ever grows as more luxury charts land; the offsets and the zeros are the part
that must not move.

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

That last refusal is specific to this corpus: 127 of 415 charts embed the
equivalence inside the label because there was nowhere structured to put it, and
appending a second copy is noise. **Noise on a certificate is indistinguishable
from a bug.**

It renders through `sizeVerificationLine` in `grading-size.ts`, the line US-2213
already uses for the verified size, so the conversion inherits that trusted-block
discipline instead of getting a path of its own. When it refuses, the line is
**byte-identical** to what it was before this shipped — asserted by string
equality over eight refused shapes, not by resemblance.

## Extended sizing is a dimension that now has data in it

`size_class` (plus / petite / tall / big_and_tall / maternity) is representable,
and as of the US-3294..3298 batches it is populated. Counted at 415 charts on
2026-09-10: **nine extended charts**. Six plus (Levi's, Madewell, The North
Face, Spanx, Nike, Marmot, all Women), two big_and_tall (Marmot, Johnnie-O, both
Men) and one petite (Reformation, Women). Each declares its class in the
`garment` scope, which is the only place `detectSizeClass` reads; a remark in
`note` is deliberately not matched.

Talbots is still the one chart that resolves to `null`, because its scope reads
"Misses (US 2-18) / Petite (0P-16P) / Plus (14W-26W)" and names three classes at
once. That is the folding this dimension exists to end, so refusing beats
collapsing it to a class that would be false for two thirds of its rows. The
test pins that SHAPE rather than a count: the unclassed list must be exactly
`["Talbots|Women"]`, and the extended count is deliberately left unpinned so
nobody is taught to bump a number.

Seeding more plus/petite/tall charts stays a **sourcing** project, like the RN
coverage gap in [[brand-kb-negative-findings]]. Since 2026-08-17 the reading half
above exists, so a chart added tomorrow is *read* rather than stored.

## Related

- [[brand-kb-sizing-units]] — the neighbouring question: the same system, but two brands printing different measurements under one label

- [[brand-kb-decoder-bar]] — the discipline this note applies to sizing.
- [[brand-kb-negative-findings]] — the other place absence is recorded as correct.

> **Re-read 2026-09-11.** US-3324 changed one brand's `brand_match` array in `sizing-charts.ts`; no size system, conversion or chart shape this note describes moved.
