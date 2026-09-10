---
title: Filling the size-chart gaps, ten brands at a time
aliases: [size chart backfill, size chart coverage, sizing chart gaps]
type: runbook
status: current
source_of_truth: vault
code_refs:
  - scripts/size-chart-coverage.mjs
  - services/edge-functions/src/lib/sizing-charts.ts
  - services/edge-functions/src/routes/flipdesk-size-bands.ts
  - scripts/gen-sizing-chart-seed.mjs
reviewed: 2026-09-09
tags: [brands, sizing, backfill, runbook]
summary: How to close a batch of brand size-chart gaps, why coverage is measured through the resolver rather than by counting rows, and what a batch must carry before it can be closed.
---

# Filling the size-chart gaps, ten brands at a time

The size-guide panel (US-3283) shows a brand's own chart in the composer's
Measurements card. Where no chart resolves, it shows a garment diagram and a web
search, which is honest but is not the product. Closing that distance is a data
job, and it is the kind of data job that goes wrong quietly, so this note says
how a batch is run and what makes one finishable.

## Coverage is what RESOLVES, not what exists

`deno run --allow-read --allow-write scripts/size-chart-coverage.mjs`

The obvious metric, "how many charts does this brand have", is the wrong one.
The panel does not ask that question. It asks `findSizingCharts(brand, garment)`
and then narrows by `categoryMatch`, so a brand holding two charts can still show
an empty panel for jeans because both of its charts are tops. The script runs a
representative query per measurement group through that same path and reports
what a seller would actually see.

Two consequences worth keeping in mind:

- **Adding a chart is not the same as closing a gap.** A chart whose
  `categoryMatch` misses the words sellers use resolves for nobody. Re-run the
  script after adding one; if the cell is still blank, the keywords are wrong.
- **A brand is only judged on groups it should cover.** An apparel brand is
  expected to cover tops, bottoms and outerwear; dresses count only for a brand
  that sells to women or unisex at all. A shoe brand is judged on shoes. Without
  that rule the report ranks Rolex as the corpus's biggest gap and puts "missing
  dresses" against Dickies, and a priority list nobody believes is a priority
  list nobody works.

## One batch

Batch size is **ten brands**, matching how migrations `00447`-`00467` were
grouped. Get the batch with:

```
deno run --allow-read scripts/size-chart-coverage.mjs --gaps --limit 10
```

The ordering is worst-first then alphabetical, so a re-run gives the same batch
until the previous one lands. For each brand in the batch:

1. Find the brand's **own published guide**. Not a reseller blog, not a
   marketplace's generic table. If the brand has taken its guide down, say so in
   the story note and move on rather than substituting someone else's numbers.
2. Add a `SizingChart` per missing group to `sizing-charts.ts`, with
   `categoryMatch` words a seller would actually type, and `sourceUrl` set to
   that guide. See [[brand-kb-provenance]]: a brand fact that cannot be traced is
   indistinguishable from one somebody invented, and it will be believed anyway.
3. Record what the numbers MEAN. `measurementBasis: "flat"` for a brand that
   publishes garment specs; absent (body) otherwise. Getting this wrong adds ease
   on top of ease and makes every correctly sized item read as oversized.
4. Leave `verified` absent unless a human compared the rows against `sourceUrl`.
   The tier is what the panel shows the seller, and an estimate wearing the
   brand's name is the one thing it must never do.
5. Do NOT convert a size label from one brand into another's, ever. See
   [[brand-kb-sizing-units]].

Then, once for the batch:

- `deno run --allow-read --allow-write scripts/gen-sizing-chart-seed.mjs` to
  regenerate the `brand_size_charts` backfill migration. `sizing-chart-parity_test.ts`
  fails if the committed SQL and the code disagree, so this is not optional.
- `deno run --allow-read --allow-write scripts/size-chart-coverage.mjs` to
  refresh `docs/size-chart-coverage.md`.
- The migration triple applies to the regenerated SQL like any other. Load the
  `migrations` skill.

## A batch is done when

- Every brand in the batch has no missing group in the regenerated report, or the
  story note names the brand and says why (guide withdrawn, brand does not sell
  the group, sizing is bespoke).
- Every new chart carries a `sourceUrl` pointing at the brand's own page.
- The parity test passes, so the DB seed and the in-code corpus agree.

## Where it stood at the start

2026-09-09, before the first batch: 167 brands, 289 brand-specific charts, **106
brands missing at least one group they should cover**, **0 charts carrying the
brand's own guide URL** and 0 verified against one. That last pair is why the old
Measurements link fell through to a Google search for nearly every brand: the
fallback was not a fallback, it was the normal case.

Related: [[brand-taxonomy-overview]], [[size-system-conversions]],
[[measurement-accuracy]].
