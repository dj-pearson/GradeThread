---
title: Filling the size-chart gaps, ten brands at a time
aliases: [size chart backfill, size chart coverage, sizing chart gaps]
type: runbook
status: current
source_of_truth: vault
code_refs:
  - scripts/size-chart-coverage.mjs
  - scripts/gen-sizing-chart-batch.mjs
  - services/edge-functions/src/lib/sizing-charts.ts
  - services/edge-functions/src/routes/flipdesk-size-bands.ts
  - scripts/gen-sizing-chart-seed.mjs
  - supabase/migrations/00776_sizing_chart_sources.sql
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
- **A brand is only judged on groups it should cover:** tops, bottoms and
  outerwear for an apparel brand, and for anything else only what it already
  sells. Without that rule the report ranks Rolex as the corpus's biggest gap.
- **Dresses are printed but never counted as a gap.** Batch 1 taught this: the
  rule used to be "dresses count for any brand selling to women or unisex", and
  three of that batch's ten brands came back still flagged — Canada Goose,
  Champion and Denim Tears, none of which makes a dress. Three false gaps in ten
  is enough to send later batches chasing charts that cannot exist. The dress
  column is still printed per brand, so a real gap stays visible.

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

- `gen-sizing-chart-seed.mjs` and `gen-size-systems-migration.mjs` regenerate
  00498 and 00499. `sizing-chart-parity_test.ts` re-derives both and fails on
  drift, so this is not optional — **but neither file ever reaches prod again.**
  They are already applied, and `apply-prod-migrations.sh` skips every file at
  or below the highest recorded version. Regenerating them keeps the repo honest
  about what the code says; it moves no rows.
- `gen-sizing-chart-batch.mjs NNNNN` is what actually carries the batch to prod:
  a migration holding every chart in the corpus that has a `sourceUrl`, upserted.
  It re-emits earlier batches' rows too, which costs nothing and spares anyone
  the bookkeeping of which brand landed in which migration. **While the current
  batch migration is still HELD, pass its number and regenerate it in place**
  rather than adding a new file — the operator's apply list stays at one. Take a
  new number only once the held one has been applied.
- `size-chart-coverage.mjs` refreshes `docs/size-chart-coverage.md`.
- The migration triple applies like any other. Load the `migrations` skill.

**A sourced row needs a CONFIDENCE, not just a URL.** `brand_size_charts_sourced`
(00578) is a CHECK on both columns, added NOT VALID so the legacy unsourced rows
stay readable — but it fires on every INSERT and on every UPDATE. Batch 1 shipped
its first cut with the URL alone and prod rejected all 19 rows with 23514. The
batch generator now writes `0.85`, the top of the range the hand-written packs
use, which is the right end when the numbers are the brand's own and the only
uncertainty is the transcription. `verified` stays false: confidence rates the
DATA, `verified` records whether a HUMAN checked, and the panel's trust badge
reads the second one.

**00498 and 00499 are regenerated but must never be RE-RUN.** A hand re-run on
prod fails: 00498 would insert the batch's rows unsourced, and 00499's UPDATE
touches every chart in the table, so the NOT VALID check fires on both. Both now
sit behind an `applied_migrations` check that raises a notice and returns.
Verify a batch the way batch 1 was verified: apply all three files to a local
Postgres that already records 00498/00499 and carries the constraint, then apply
the batch file a second time.

## A batch is done when

- Every brand in the batch has no missing group in the regenerated report, or the
  story note names the brand and says why (guide withdrawn, brand does not sell
  the group, sizing is bespoke, the published table's columns cannot be read).
- **A batch of ten need not close ten.** Batch 2 closed four. Six brands were
  left on the list with reasons: two publish no numeric chart at all, one site
  was erroring, and one printed two bust runs three inches apart without saying
  whether either was a body or a garment measurement. Shipping four sourced
  charts and four honest reasons beats shipping ten charts where six are guesses,
  and the coverage report re-derives the next batch from what is actually left.
- Every new chart carries a `sourceUrl` pointing at the brand's own page.
- The parity test passes, so the DB seed and the in-code corpus agree.

## The yield split, and what it means for the rest of the loop

Three batches in, the corpus divides cleanly and it is not about brand size:

- **Mass-market retailers publish a plain HTML size table at a stable URL.**
  American Eagle, Banana Republic, Champion, Levi's, Dickies, Madewell, Duluth,
  SKIMS. Batch 1 closed 9 of 10 and batch 2 closed 4 of 10 from this half.
- **Premium and streetwear labels mostly do not.** rag & bone renders three rows
  of its own run plus a corrupted conversion table; PAIGE's `/size-guide` renders
  no chart; Moncler's sits behind a panel that emits no table; Mackage's page is
  empty; FRAME's fit guide is blank; PacSun's `/size-chart.html` and Kith's
  `/pages/size-guide` are 404s. Batch 3 closed **1 of 10**.

The gap list is now mostly the second kind, so expect a batch to close two or
three rather than nine. That is the loop working: a batch that ships three
sourced charts and seven checkable reasons is worth more than one that ships ten
charts where seven are guesses. When a batch closes almost nothing, the useful
move is to say so rather than to lower the sourcing bar.

## Where it stands

2026-09-09, before batch 1: 167 brands, 289 brand-specific charts, **0 charts
carrying the brand's own guide URL** and 0 verified against one. That pair is why
the old Measurements link fell through to a Google search for nearly every brand:
the fallback was not a fallback, it was the normal case.

After batch 1 (US-3284): 308 charts, 19 sourced across 10 brands, 81 brands with
a gap. Nine of ten closed; FRAME did not.

After batch 2 (US-3285): 313 charts, 24 sourced across 14 brands, 77 with a gap.
Four of ten closed (Dickies, Levi's, Madewell, Duluth).

After batch 3 (US-3286): 314 charts, 25 sourced across 15 brands, 76 with a gap.
One of ten closed (SKIMS).

⚠ The coverage report measures the IN-CODE corpus, not the database. Prod's
`brand_size_charts` already held source URLs on the hand-written pack rows
(329 of 340 sourced after batch 1). The gap this loop closes is the in-code
fallback's, which is what every client compiles in.

Related: [[brand-taxonomy-overview]], [[size-system-conversions]],
[[measurement-accuracy]].
