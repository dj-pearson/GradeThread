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
  - supabase/migrations/00498_sizing_charts_backfill.sql
  - supabase/migrations/00776_sizing_chart_sources.sql
  - supabase/migrations/00779_sizing_chart_sources.sql
  - supabase/migrations/00780_sizing_chart_sources.sql
  - supabase/migrations/00781_sizing_chart_sources.sql
  - supabase/migrations/00782_retire_orphaned_size_charts.sql
reviewed: 2026-09-10
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
6. CARRY THE PACK'S CAVEATS ONTO THE NEW CHART. A transcription is a chart the
   seller may be handed ALONE: once a brand has a bottoms chart, a bottoms
   lookup stops returning the tops chart, and any warning that lived only there
   stops being delivered. Measured on 2026-09-10 across the basics/mall group:
   44 of 168 brand-plus-category lookups delivered no "measure the garment"
   instruction, and 8 of Tommy Hilfiger's 14 delivered no era caveat, all of it
   introduced by batches that were otherwise correct. See
   [[size-chart-guard-properties]] for the ledger of what is still missing.

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

## 00498 is a generated migration that has already been applied, and it must never run again

`supabase/migrations/00498_sizing_charts_backfill.sql` is the one file in this
loop that is **both a generated artifact and an applied migration**, and the two
facts fight each other. Read this before regenerating it.

It backfilled `brand_size_charts` from the in-code `SIZING_CHARTS` seed (US-2214),
because `sizing-charts.ts` carried 415 charts across 171 brands and only a couple
of dozen had ever reached the table — so the DB-first resolver fell through to the
frozen in-code copy for almost every brand, **silently**, since the fallback always
returns something. The admin curation surface had nothing to edit for those brands.

It is **not a verification pass**. Every row lands with `verified = false`,
`confidence = NULL` and `source_url = NULL`, because the in-code seed carries no
per-chart provenance to copy. Read `verified = false` as "not yet reviewed by a
human", which was already true, not as "suspect". Its conflict target is
`brand_size_charts_key_idx` and it is `ON CONFLICT DO NOTHING` deliberately: the
hand-written packs from `00447` onward carry real `source_url` and `confidence`
values and must not be overwritten by an unsourced backfill. **Where a pack
already seeded a chart, the pack wins.**

The hazard is the regeneration. `scripts/gen-sizing-chart-seed.mjs` rebuilds this
file whenever `sizing-charts.ts` changes, because `sizing-chart-parity_test.ts`
re-derives it and fails on drift. A rebuilt copy must never **execute** against a
database that already has it:

- `apply-prod-migrations.sh` skips every file at or below the highest recorded
  version, so a re-run only happens when a human runs the file by hand. That is
  exactly what happened on 2026-09-09.
- A hand re-run **fails**. `00578` added `brand_size_charts_sourced` NOT VALID, so
  legacy unsourced rows stay readable, but any INSERT or UPDATE must satisfy it
  and every row in this file is deliberately unsourced. See
  [[brand-kb-provenance]].

So the statement sits behind an `applied_migrations` check: on a fresh database it
runs, on prod it raises a notice and does nothing. New charts reach prod through
the batch migrations `gen-sizing-chart-batch.mjs` emits, which carry a real
`source_url` and `confidence`.

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

After batch 2 (US-3285): 331 charts, **42 sourced across 19 brands**, and 71
brands still carrying a gap. All ten of batch 2 closed, with no exception.

⚠ **Two of those ten publish no working size-guide PAGE any more** — Mackage's
`/pages/size-chart` renders a store locator and PAIGE's `/size-guide` renders
its heading with nothing under it — but both still publish the chart inside the
product page's Size Guide panel. That is the brand's own page, so the rule in
step 1 is satisfied and `sourceUrl` points at a product. It is a weaker URL than
a guide: a discontinued product 404s and a guide page does not. Prefer a guide
where one exists, use a product where none does, and say so in the chart's note
so a dead link later has a known cause rather than looking like a typo.

⚠ **Three brands could not be fetched at all without a real browser.** Levi's,
Madewell, Lucky Brand and PacSun answer `curl` with 403 whatever the headers
say, and Mackage, MOTHER, Moncler and PAIGE render their tables in JavaScript,
so an HTTP fetch returns a page with no numbers in it — which reads exactly like
a brand that stopped publishing. Two things saved time and are worth reusing:
a Shopify store often ships the whole guide as a JSON asset (Hudson's is
`/cdn/shop/t/82/assets/size-guide.json`, found by grepping the page source for
`size-guide.json`), and a table whose cells come back EMPTY through a browser is
usually rendered in a hidden tab — read `cell.textContent`, not `innerText`.

After batch 3 (US-3286): 352 charts across 168 brands, **67 sourced**, and 64
brands still carrying a gap. Seven of the batch's nine closed. It was NINE and
not ten because the story's tenth brand, Aerie, already showed no gap.

⚠ **Two exceptions, and they are different shapes.** Rag & bone publishes a
women's apparel chart with THREE rows in it — 00, 0 and 2 — and a centimetre
column that prints "131" where the inch column says 31; its product URLs 404.
Transcribing three XXS-XS rows would be worse than nothing, because the band
builder maps to the nearest row and would report a seller's size-M top as a rag
& bone 2. Anti Social Social Club is the other shape: its per-product Size Chart
accordion holds a real flat-spec table on TOPS and is EMPTY on every pair of
sweatpants checked, and `/pages/size-guide` 404s. Neither was substituted for.

⚠ **A batch can DELETE a chart, and this one did.** The shared
"The North Face / Patagonia (outerwear)" pseudo-brand entry is gone. US-1734 had
already narrowed it once, pulling Columbia and Arc'teryx out when they got their
own charts, because a brand present in both makes the resolver hand back the
shared row AND the brand row — two charts with the same numbers competing for
the three-chart prompt budget. Its own comment said it stayed "for the two
brands that have no own-brand chart", so once both had one it had nobody left to
serve. **The DB row survives** and nothing sweeps it: the generated migration is
an upsert, the resolver matches on brand NAME rather than key, and adding a
DELETE to a generated file to chase one inert row is the more dangerous change.

⚠ **A brand-wide conversion is a legitimate chart when a brand has nothing
else.** Aime Leon Dore publishes garment specs per product and no body chart at
all, and the specs differ enough between styles to make a brand-level number
dishonest — its Officer Pant lists a 29.5in relaxed waist at size 28 while its
Elasticated Trouser lists 26in at XS. What IS brand-wide is the alpha-to-numeric
conversion printed identically on every product, so that is all its chart
claims. Herno's Italian-sizing entry is the same pattern from batch 1.

After batch 4 (US-3287): 366 charts across 168 brands, **83 sourced**, and 56
brands still carrying a gap. Eight of ten closed.

⚠ **A batch can REPLACE a chart, and this one did.** Cotopaxi already had a
men's and a women's chart, both approximations with no source, and both too
narrow to reach bottoms. Adding a sourced pair beside them would have recreated
the two-competing-charts problem US-1734 fixed for The North Face, so batch 4
rewrote the existing two in place: real rows, a real `sourceUrl`, and a widened
`categoryMatch`. **Prefer this to adding a duplicate whenever a brand already
has a chart in the department you are filling.** The generated migration handles
it without special-casing, because the upsert keys on brand, department and
garment and those did not change.

⚠ **THE FIRST `flat` CHART IN THE CORPUS.** Bonobos states it above its own
table — "Measurements reflect garment dimensions. All units are in inches" — so
its two charts carry `measurementBasis: "flat"`. Everything shipped in batches 1
through 3 was body. This is what step 3 has been waiting for: the rule was never
"assume body", it was "record what the brand says", and until now no brand in
the backfill had said this.

⚠ **Two exceptions, and one of them is MINE rather than the brand's.** Chrome
Hearts is the brand's: `/pages/size-guide` 404s and its per-product tables
disagree with each other — its leggings chart starts at XS with a 20-25in waist,
its long johns chart has no XS at all and starts at S with 23-28in — so there is
no brand-level bottoms chart to take, and it has no conversion table to fall
back on the way Aimé Leon Dore does. **Burberry is a tooling failure and should
not be left as an exception without a human look**: its own
`/customer-service/faqs/size-guide/` redirects to Contact Us on both the US and
CA sites, and the chart lives only in a product-page modal on a page that made
the browser renderer unresponsive three times running. That is a different claim
from "the brand stopped publishing", and the note should not blur them.

⚠ **A cm-only brand is fine; say so in the note.** Barbour publishes
centimetres with no unit toggle anywhere. Converting its own columns to inches
is arithmetic on the brand's numbers, not a substitution, and the chart note
records that it happened. What must NOT be folded in is Barbour's separate
advice to add 4-6in for layering — that is a fit instruction about waxed
jackets, not part of the measurements.

After batch 5 (US-3288): 376 charts across 168 brands, **93 sourced**, and 50
brands still carrying a gap. Six of ten closed, and the four that did not are
the most instructive part of the batch.

⚠ **"No chart" has at least four different causes, and the note must say
which.** Batch 5 hit all four at once:
- **Fila's US STORE IS CLOSED.** fila.com serves "the shop is on pause" and
  every deeper URL returns a Korean 404. Nothing to take because there is no
  store. Recheck when it reopens.
- **Kith** publishes a table per product and they disagree — its overshirt and
  its moto jacket differ in EVERY column at the same size. Chrome Hearts' shape.
- **Hellstar's** own `/pages/size-chart` exists and renders a product grid with
  no table on it, and every chart a search returns belongs to a reseller
  (pushas, hellstars-store, hell-star, restockar). The do-not-substitute rule.
- **Fear of God Essentials** is a control that does not work: the product page
  carries a SIZE CHART element whose text is in the DOM but which opens nothing,
  through two different click paths, and `/pages/size-guide` 404s.

⚠ **A per-product corpus can still yield ONE brand-level row.** Gallery Dept.
prints a different table on every product, but the WAIST row is identical on all
of them: the tag size is 2in under the garment waist, the whole way up. That is
a brand fact and it closes the gap. Everything else in their table is per-style
and was left out — between two of their own jeans the low hip differs by 2in at
the same size, the front rise by 1.5in, the inseam by 1.25in. **Check two
products before concluding either way**; one product tells you nothing about
which rows are brand-level.

⚠ **When a brand's page fights you, look for the data instead.** Gap's chart
page freezes a browser, but Gap serves the same numbers as plain JSON:
`/Asset_Archive/AllBrands/sizeChart/v3/data/gap/us_charts.js` maps a `cid` to a
filename and `.../current/<file>` is the chart. Hudson's Shopify JSON in batch 2
was the same trick. Grep the page source for `.json` or a `data/` path before
resorting to clicks.

⚠ **Two brands' URLs are spelled inconsistently between departments.** Nike's
men's bottoms chart is `mens_bottoms_alpha` with UNDERSCORES and its women's is
`womens-bottoms-alpha` with HYPHENS; each 404s on the other's form. Lee's
`/shop/men-size-charts` is a broken search page rendering "Results 0" while
`/size-charts.html` carries all 23 tables. A 404 is not evidence a brand stopped
publishing until the other spelling has been tried.

After batch 6 (US-3289): 378 charts across 168 brands, **102 sourced**, and 44
brands still carrying a gap. Six of ten closed.

⚠ **BY BATCH 6 THE DEFAULT IS REPLACE, NOT ADD.** Six of this batch's ten
brands already had an approximation chart, so their rows were rewritten in place
and their `categoryMatch` widened to reach the missing group — Old Navy, SKIMS,
Rab (both departments), Stüssy, PUMA and Reebok. Only two charts in the whole
batch are genuinely new. The corpus is dense enough now that adding beside an
existing chart is usually the wrong move; check what the brand already has
before writing anything.

⚠ **A brand's OWN page can be the wrong page.** PUMA's US size-charts page has
21 tables on it and NOT ONE carries a body measurement — they are country
conversions and how-to-measure captions. The real chart is on PUMA's AU site.
"The page has tables" is not the same as "the page has a size chart", and a
count of tables will lie to you.

⚠ **Two of a brand's own tables can disagree, and then they need two charts.**
Reebok's tops table wants a 33-36in waist at M and its bottoms table wants
32-35in. Registering one chart under both groups would have made the size check
answer differently depending on nothing the seller can see. Rab is the same
shape in a different way: what Rab calls XXL is a US XL and its 3XL is a US XXL,
both printed on its own page, so the size labels carry both.

⚠ **Four exceptions, all four the brand's own doing.** Palace has no size
guide anywhere on its own site — palaceskateboards.com carries only /advice and
/shops, shop.palaceskateboards.com/pages/size-guide 404s, and
boring.palaceskateboards.com renders the words "Boring Stuff" and nothing else.
Rhude's domain does not resolve at all. Sp5der's official store serves an
88-byte placeholder for every URL including its own size-guide path. PINK's
chart lives on a JS-only Salesforce help article that the browser could not
render. Every chart a search returns for Palace and Rhude belongs to a reseller.

After batch 7 (US-3290): 383 charts across 168 brands, **111 sourced**, and 40
brands still carrying a gap. Four of eight closed — eight and not ten, because
the story listed Alo Yoga and Athleta and both already showed no gap.

⚠ **NOT EVERY UNSOURCED CHART IS AN APPROXIMATION.** Two of batch 7's four
brands needed only a URL: Beyond Yoga's and UNTUCKit's women's rows were already
the brand's own numbers, sitting in the corpus with no `sourceUrl` and a
`categoryMatch` too narrow to reach the missing group. Re-checking them against
the live page took a minute and transcribing them again would have taken twenty.
**Read the existing note before you fetch anything** — if it says
"brand-published" or "from the official guide", the job is a URL and a widened
keyword list, not a transcription.

⚠ **A brand's size labels can be offset from US ones, and only its own
conversion table will tell you.** Woolrich men's runs ONE SIZE LARGER: its
conversion says Woolrich XXS = USA XXXS through XXXL = USA XXL, so a Woolrich
men's L is a US M. Its WOMEN'S labels line up normally. That fact is on no page
Woolrich publishes under a size-chart URL — both return 200 with no table, its
US store is a separate Shopify shop whose /pages/size-* paths 404, and the only
place it appears is the product page's size drawer.

⚠ **A table on a size-chart page is not necessarily a size chart.** UNTUCKit's
is headed "Men's Pants" and is an inseam AVAILABILITY matrix — 30/32/34in,
ticks and N/A, no measurement anywhere in it. Its only men's bottoms numbers are
on the SHORTS table.

⚠ **Four exceptions, all the brands' own doing.** Buck Mason publishes a table
per product and two of its own jackets disagree in both values and column names
("Chest" vs "Chest Circumference", an inch apart at every size). Brandy Melville
is a one-size brand whose /pages/size-guide serves a product listing and whose
measurements live inside each product DESCRIPTION. Chanel's
/us/fashion/size-guide/ redirects to the collections landing page; its US
ready-to-wear is boutique-only and it publishes no chart. BAPE's SIZE GUIDE
control renders nothing through two click paths, which is the Burberry shape and
worth a human look.

After batch 8 (US-3291): 383 charts across 168 brands, **112 sourced**, and 35
brands still carrying a gap. Five of six closed — six and not ten, because the
story listed Columbia, Fjällräven, Gymshark and Helly Hansen and all four
already showed no gap.

⚠ **A COVERAGE GAP IS NOT ALWAYS A MISSING CHART.** Five of batch 8's six gaps
were outerwear-only, on brands that already had a chart describing the same
body — the keywords just did not reach the group. Widening `categoryMatch`
closed them and added no rows and no `sourceUrl`, because nothing new was
claimed. **Run the resolver before deciding what a gap needs**: a two-minute
`findSizingCharts` check tells you whether you are looking at a missing chart or
a missing keyword, and they are very different jobs.

⚠ **The batch-7 lesson cuts BOTH ways.** Batch 7 found two unsourced charts
whose rows were already the brand's own. Batch 8 found the opposite: Girlfriend
Collective's rows were an approximation about an inch off, drifting further up
the run — XXS read bust 30-32 where the brand publishes 29-31. CHECK; do not
assume in either direction.

⚠ **A widening still needs a note that says what it is.** Each of the four
unsourced widenings carries a line saying the rows are the same approximation,
that the brand's own page could not be read from here, and that a body chart
describing a brand's tops describes its jackets too. Without that, the next
reader cannot tell a widened approximation from a sourced chart.

After batch 9 (US-3292): 394 charts across 168 brands, **121 sourced**, and
29 brands still carrying a gap. Six of six closed — six and not ten, because
the story listed Kühl, Lululemon, Mammut and Off-White and all four already
showed no gap. Four needed a new sourced chart (Marmot, Mountain Hardwear,
Johnnie-O, Kate Spade) and two needed only wider keywords (Janie and Jack,
Mini Boden).

⚠ **THE SAME PLATFORM CAN SERVE ITS GUIDE TWO WAYS, AND ONE OF THEM IS
INVISIBLE TO CURL.** Marmot and Mountain Hardwear both run Salesforce
Commerce. Marmot's `/pages/size-chart` is 410 GONE, but the data route
`/on/demandware.store/Sites-marmot-Site/default/Product-SizeChart?cid=size-chart-mens-bottoms`
answers a plain curl with clean HTML tables (swap mens/womens, tops/bottoms
in the cid). The identical URL shape on Mountain Hardwear returns 200 with
ZERO tables: its guide is a product-page modal built from divs, opened by
`button.js-sizeguide-modal`. **Try the data route first; fall back to the
browser and the modal.**

⚠ **A 404 ON `/pages/size-guide` MEANS THE PATH IS WRONG, NOT THAT THE CHART
IS MISSING.** Johnnie-O's tops chart carried a note saying its standard
bottoms chart "COULD NOT BE SOURCED and is deliberately absent". It could:
the guides live at `/size-guide/<audience>-<group>` — `mens-bottoms`,
`womens-bottoms`, `boys-bottoms`, `mens-big-and-tall-bottoms` — with no
`/pages/` prefix at all. The route was one link-text query away on any
product page. **Read the size-guide link off a PDP before recording a
brand as unsourceable.**

⚠ **A GARMENT RENAME LEAVES A LIVE ROW IN PROD, AND IT IS NOT INERT.** The
upsert key on the sourced-chart migrations is
`(brand_key, department, garment)`. Batches 2 through 8 renamed the garment
scope whenever they widened a chart ("Tops" → "Tops & outerwear"), so each
rename INSERTED a row instead of updating one, and the retired
approximation stayed in `brand_size_charts` with its old keywords. The
earlier note in PENDING_MIGRATIONS.md called those rows inert. They are not:
`brand-knowledge.ts` prefers the DB WHOLESALE — any row for a brand makes
the DB the entire answer — so a Woolrich jacket would resolve the
approximation AND the brand's own numbers, competing for the same
three-chart budget. 00782 deletes the fourteen by name. **When a batch
renames or removes a chart, the DB needs a delete; the upsert cannot see
it.**

⚠ **ONE OFFICIAL CHART CAN REPLACE TWO INVENTED ONES.** Kate Spade carried a
"Dresses (US numeric)" chart and a "Tops & knits (US alpha)" chart, both
grades this corpus made up. The brand publishes ONE clothing chart — numeric
run, alpha band and denim waist in a single table — covering everything it
makes, which is also what finally reached bottoms. Deleting the two and
writing one is better than sourcing either.

After batch 10 (US-3293): 400 charts across 168 brands, **133 sourced**, and
20 brands still carrying a gap. Nine of nine closed — nine and not ten,
because Outdoor Research already showed no gap. Four needed a new sourced
chart (Orvis, Pendleton, REI Co-op, Reformation), four needed only wider
keywords (Outdoor Voices, Prada, Rebecca Minkoff, Supreme), and one is an
exception.

⚠ **KEEP THE `garment` STRING UNCHANGED ON EVERY REPLACEMENT.** This is now
the rule, and it follows directly from the orphan defect above: the
sourced-chart migration upserts on `(brand_key, department, garment)`, so a
rename INSERTS rather than updates. Widen `categoryMatch` instead — it is not
part of the key, so widening is free. Batch 10 replaced four charts and added
eight, and the orphan list stayed at exactly fourteen. Re-run the old-versus-
new tuple diff after a batch to prove it.

⚠ **THE INVENTED OUTDOOR-ALPHA GRID IS TOO NARROW AT THE TOP OF THE RUN.**
Orvis, Pendleton and REI Co-op all carried an approximation reading L 41-43
against a published 42-44 or 42-45, and Orvis's XXL read 47-49 against a
published 50-52 — three inches out. Assume the same about any remaining chart
whose note says "standard outdoor-alpha approximation"; the error is
systematic, not per-brand.

⚠ **A GAP CAN BE A VOCABULARY MISMATCH RATHER THAN A MISSING KEYWORD.**
Rebecca Minkoff's apparel chart already said "top" and "blouse" and still
read as a top gap, because the coverage probe asks with "tee", "shirt",
"hoodie" and "sweater" — the words a seller types. A `categoryMatch` written
in merchandiser vocabulary resolves for nobody.

⚠ **KNOW WHEN TO STOP.** Sézane is this batch's one exception. Three of its
size-guide paths return 403 to a plain fetch, the browser follows every one to
the /us-en homepage, no size link appears in its footer, and the domain trips
the browser tool's query-string guard on most reads. Two approaches and out:
its existing tops chart carries a waist column, so the bottom gap was closed
by widening that chart with a note saying precisely what could not be read.
A documented exception beats an invented chart and beats an hour of retries.

⚠ **NOT EVERY BRAND HAS A BRAND-WIDE BOTTOMS GRID.** Pendleton publishes hip
and rise PER PRODUCT and nothing brand-level, so its bottoms chart is one
style's FLAT garment specs with `measurementBasis: "flat"` and a note naming
the style. That is honest and useful; a body chart invented from it would be
neither.

After batch 11 (US-3294), the last story in the program: 400 charts across 168
brands, **133 sourced**, and **18 brands still carrying a gap**. Batch 11 was
the smallest of the eleven — SIX brands listed, TWO real: Sweaty Betty,
Theory, Under Armour and Vuori had all been closed by earlier batches'
widenings before their own story came up. Todd Snyder and Vineyard Vines were
both keyword-only.

⚠ **A LONGER KEYWORD IS A NARROWER ONE.** Todd Snyder's `categoryMatch`
already contained "chore coat" and "outerwear" and it STILL read as an
outerwear gap, because matching is `query.includes(keyword)` — a substring
test on the QUERY. The query "jacket" contains neither string, so the chart
never resolved. Adding words to a list does not widen it unless the words are
SHORTER and are the ones the resolver actually asks with.

⚠ **THE ELEVEN BATCHES DID NOT CLOSE THE CORPUS, AND THAT IS NOT A FAILURE OF
THE BATCHES.** Each story's brand list was snapshotted when the program was
written; the eighteen brands still short were never on any of the eleven
lists. US-3297 and US-3298 carry them. Several are already documented
exceptions from earlier batches (Palace publishes no chart, BAPE's control
renders nothing, Buck Mason and Burberry from batch 7, Filson from batch 8),
so **read the exception notes before spending a browser session** — that is
what they are for.

Batch 12 (US-3297): 407 charts, **143 sourced**, 12 brands with a gap. Six of
nine closed outright (Chanel, Fear of God Essentials, Hellstar, BAPE, Palace,
Sp5der) and three left as exceptions (Anti Social Social Club, Chrome Hearts,
Kith).

⚠ **A STREETWEAR BRAND SERVES ITS CHART FOUR DIFFERENT WAYS, AND NONE OF THEM
IS A SIZE-GUIDE PAGE.** All four turned up in this one batch, and every earlier
note calling these brands unsourceable was describing the technique rather than
the brand:

1. **A PNG in the theme file store** (Hellstar). Filter `img` by
   `naturalWidth !== naturalHeight` — product photos are square, the chart is
   the one landscape image — then READ THE PICTURE.
2. **An ordinary HTML page on an undiscoverable path** (BAPE,
   `/pages/size-guide-us`, nine tables to a plain curl). The path is only
   findable by reading the SIZE GUIDE `<a>` on a product page.
3. **JSON embedded in the PDP markup** (Palace):
   `{"measurements":[{"name":"Waist","measures":[...]}],"variant_names":[...]}`.
   Its domain refuses script execution, so fetch the HTML and read it.
4. **A third-party app bundle** (Sp5der): the PDP loads
   `size-guides-prod.esc-apps-cdn.com/<ts>-app.<shop>.myshopify.com.js`, and
   that one 432 KB file holds all **119** of the brand's per-style charts as
   JSON, keyed by product tag. The URL is sitting in the served markup.

⚠ **PER-STYLE IS THE STREETWEAR NORM.** Palace and Sp5der publish garment
specs per product, not one brand grid, so both charts carry
`measurementBasis: "flat"` and name the style they came from. Palace's size-30
tag is a 33.5in GARMENT waist — three and a half inches of deliberate ease, not
a mis-tag.

⚠ **A PROVENANCE HOST IN A COMMENT TRIPS THE SUBPROCESSOR GUARD.** The derived
exemption in `subprocessors-complete.test.ts` reads `sourceUrl:` values only, so
Sp5der's app-bundle host — which appears in a code comment and is never called
— failed the outbound-host check. It is now a named `NOT_A_PROCESSOR` entry,
the same treatment the USPS rate-table URL gets.

⚠ **HOW TO FIND A STREETWEAR SHOPIFY STORE'S SIZE CHART: LOOK FOR THE
LANDSCAPE IMAGE.** Every technique the earlier batches used fails on these
stores — `/pages/size-guide` 404s, the PDP has no `<table>` and no modal, and
`products.json` carries no measurements. The guide is a PNG in the theme's
`/files/` store, dropped into the product description. What gives it away is
the ASPECT RATIO: Shopify product photos are square (3000x3000), and the
chart is the one landscape image on the page.

```js
Array.from(document.querySelectorAll('img'))
  .filter(i => i.naturalWidth > 300 && i.naturalWidth !== i.naturalHeight)
```

On Hellstar's sweatpant PDP that returns exactly one image, 822x436, and it
is the chart. curl it and READ THE PICTURE. ⚠ Take `currentSrc` through
`new URL(...)` and print only hostname + pathname; the raw src trips the
browser tool's query-string guard.

⚠ **A "no brand-published chart" note can be a statement about the TECHNIQUE,
not the brand.** Hellstar's description literally reads "PLEASE REFER TO THE
SIZE GUIDE BELOW" and the corpus still carried a chest-only approximation,
because every fetch-shaped route came back empty. Before recording a brand as
unsourceable, check whether its guide is simply a picture.

⚠ **WIDEN ONLY ONTO A COLUMN THAT ANSWERS THE QUESTION.** Chanel has two
charts; only the dresses one carries a HIP, so only that one was widened to
bottoms. The tweed-jacket chart has bust and waist and was left alone. The
six streetwear bottoms gaps are still open for exactly this reason: a chest
measurement does not describe a pair of trousers, and widening those charts
would put a chest number in front of a seller measuring a waistband.

After batch 13 (US-3298), the last story: 412 charts across 168 brands,
**148 sourced**, and **5 brands still carrying a gap**. Seven of nine closed;
Fila and Rhude are exceptions.

⚠ **AN EMPTY SIZE-GUIDE MODAL IS NOT AN ANSWER ABOUT THE BRAND.** FRAME's
long-sleeve waffle tee serves a size-guide drawer containing the words "Fit
Information" and nothing else — no table, no rows, an empty `<div>`. Its
leather jacket serves the full nine-row chart from the same component. One
empty modal proves nothing; **open a second product before recording an
exception**.

⚠ **THE SFCC DATA ROUTE FROM BATCH 9 KEEPS PAYING.** Rag & Bone is
Salesforce Commerce and
`/on/demandware.store/Sites-ragandbone-Site/en_US/Product-SizeChart?cid=size-chart-mens-general`
answers a plain curl. The cid is only discoverable in the `data-modal-config`
attribute on a product page's size-guide button — and the brand's ONLY
size links anywhere in its markup are `/mens/denim/fit-guide/` and
`/womens/denim/fit-guide/`, which are fit PROSE with zero tables. Following
the visible links would have closed the file on this brand.

⚠ **SFCC IS NOT A PROMISE OF A CATALOG.** fila.com also runs SFCC — its
title is literally `Sites-FILA-Site` — and every `Product-SizeChart?cid=`
guess returns a 1,259-byte 404. Its US site is corporate information only:
the whole link set is customer-service and policy pages plus outbound links
to country sites. There is no storefront to have a size chart.

⚠ **CHECK WHERE A DOMAIN ACTUALLY LANDS BEFORE CITING IT.** Batch 12 cited
Sp5der as `sp5derworldwide.com`; that domain REDIRECTS to `kingspider.co`,
and `sp5der.com` does not resolve at all. The destination self-identifies as
the official site and runs on `spider-worldwide.myshopify.com` — the brand's
own handle, which is the corroboration a self-claim needs — so the rows
stand, but both `sourceUrl`s now point at the domain that resolves and both
notes record the chain. **A redirect is how a reseller chart gets into a
corpus by accident.** Curl with `-w "%{url_effective}"` before writing a URL
into the corpus.

⚠ **A ONE-SIZE BRAND IS AN EXCEPTION, NOT A GAP.** Brandy Melville's
outerwear gap was closed by widening its entry and nothing else. There are no
measurements to add because the brand publishes no grade — its jackets come
in the same single size as its tees, and inventing numbers would assert a
grade it does not have.

⚠ The coverage report measures the IN-CODE corpus, not the database. Prod's
`brand_size_charts` already held source URLs on the hand-written pack rows
(329 of 340 sourced after batch 1). The gap this loop closes is the in-code
fallback's, which is what every client compiles in.

Related: [[brand-taxonomy-overview]], [[size-system-conversions]],
[[measurement-accuracy]], [[size-chart-guard-properties]].
