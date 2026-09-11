---
title: Size-chart guards assert properties, not the shape the corpus had that day
aliases: [size chart guards, chart content guards, size chart guard ledger]
type: learning
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/tests/_chart-properties.ts
  - services/edge-functions/src/tests/verified-chart-parity_test.ts
  - services/edge-functions/src/tests/shoe-size-scale_test.ts
  - services/edge-functions/src/tests/basics-mall-content_test.ts
  - services/edge-functions/src/lib/sizing-charts.ts
reviewed: 2026-09-10
tags: [brands, sizing, testing, guards]
summary: The 2026-09 size-chart backfill turned eighteen chart-content guards red, seventeen of them without breaking anything they guarded; the five shapes that broke, and the guard forms that survive a growing corpus.
---

# Size-chart guards assert properties, not the shape the corpus had that day

On 2026-09-10 `deno test src/tests/` in the edge service reported 18 failures,
every one of them in the brand size-chart content guards. Seventeen were guards
whose subject had moved; exactly one was a real defect.

The size-chart backfill ([[size-chart-coverage-backfill]]) took brands from one
or two charts each to as many as seven, replaced invented approximations with
the brands' own published tables, and deleted the shared charts that existed
only to serve brands with nothing of their own. Every one of those is the work
going right. The guards went red anyway, because they had pinned **where a fact
was written** instead of **what had to be true**.

## The five shapes that broke

**A named row that got deleted.** `outdoor-content` asserted "The North Face
still reaches the shared outerwear chart". The shared chart existed so that two
brands without charts of their own were not stranded; both got charts, so the
row was retired and the assertion went red while the property — nobody
stranded, nobody double-matched — had never been better satisfied. Same in
`denim-content` for Patagonia. Assert the two failure modes, not the row.

**A field, when the fact moved to a neighbouring field.** `/BODY/i.test(note)`
failed for `garment: "Bottoms, US numeric (body inches)"`. The prompt block
carries the garment scope as its heading, so a fact in `garment` reaches the
model exactly as surely as one in `note`. `declaresMeasurementBasis` reads both
and additionally cross-checks the prose against `measurementBasis` — which is
strictly stronger, because a chart declared `flat` whose note talked about body
measurements used to pass.

**A count.** `assertEquals(charts.length, 14)` was the group's size in July, not
a property. It stood in for non-vacuity, which is better said as "every brand in
the group has at least one chart" and then cannot go stale.

**A witness brand.** `shoe-size-scale` proved that an apparel chart never
answers a shoe's scale by naming six brands and the size system each read as —
BAPE JP among them. BAPE's new tables do not announce JP, so the case went red.
The dangerous half is the other direction: had BAPE gained a footwear chart, the
case would have gone GREEN while testing nothing, because a brand with a
footwear chart is a real answer rather than a trap. The witnesses are computed
from the corpus now, with a floor on how many there must be and how many
distinct systems they span.

A fifth, in `verified-chart-parity`: the guard modelled "what prod holds" from
the INSERT statements only. That was correct while the corpus was insert-only
and stopped being correct the day a migration started deleting rows.

## The ledger, and why it is not an exemption list

Some of the eighteen were reporting something real. The transcribed charts carry
the brands' numbers faithfully and do not carry the pack's grading caveats — the
Tommy Hilfiger era warning, Uniqlo's runs-small direction, the PUMA/Reebok
one-brand-two-systems warning, "measure the garment". Those are chart-content
defects, and they cannot be fixed from the test suite: `brand_size_charts` is
DB-first and the note is part of the chart tuple, so a correction is a data
migration plus a regenerated `00498` in the same commit.

`assertPropertyWithLedger` is the answer used instead of leaving the guards red.
The assertion is unchanged; the violating charts are named, each with a reason;
and the check fails in **both** directions — a listed chart that starts
satisfying the property fails until its entry is deleted, and any unlisted chart
that stops satisfying it fails immediately. So the list can only shrink, and the
guard keeps catching the next regression rather than being a red test everyone
has learned to skip. Reach for it only when the fix is genuinely out of reach;
a ledger entry for a defect you could have fixed is the failure mode the
`guards-that-do-not-guard` agent memory warns about.

One guard was NOT ledgered and is deliberately red: the bare-`duluth`
brand-match collision in `heritage-workwear-content_test.ts`. That one is a
wrong ANSWER rather than missing prose — "Duluth Pack" resolves Duluth Trading's
body chart — and hiding a wrong answer behind a ledger entry is exactly what a
ledger must never be used for.

## What to do when a size-chart guard goes red

1. Ask which of the five shapes it is before assuming the chart is wrong. A
   backfill batch that gives a brand its own chart SHOULD stop that brand
   reaching a shared one.
2. Fix by asserting the property at the boundary that matters — the lookup, the
   prompt text, the pair of failure modes — not by relaxing the regex.
3. Sabotage the rewrite. Break the property, watch it go red, restore. A
   re-chosen witness nobody sabotaged is a guess, and a sabotage can itself be
   wrong: one attempt here neutered a chart's garment label and the note still
   said "Garment measurements", so the guard passed correctly and the sabotage
   was the thing at fault.

Related: [[size-chart-coverage-backfill]], [[brand-kb-sizing-units]],
[[brand-kb-provenance]].
