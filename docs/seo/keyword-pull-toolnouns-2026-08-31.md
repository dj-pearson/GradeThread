# Tool-noun keyword pull, 2026-08-31

107 seeded terms, all 107 returned a row, plus 185 Planner suggestions. Raw
exports in `keyword/Saved Keywords Stats 2026-08-31 at 08_41_56.csv` and
`keyword/Keyword Stats 2026-08-31 at 08_42_57.csv`. Joined to their clusters in
`docs/seo/keyword-pull-toolnouns-results.csv`. Seed list and shape tags in
`docs/seo/keyword-pull-toolnouns-seed.csv`.

Run to answer one question the SERP audit of 2026-08-28 left open: the three
clean SERPs in that audit were all tool nouns, and nobody had sized the tool
nouns we do not own yet.

Same reading rules as the previous two pulls. Volumes are buckets (50, 500,
5,000, 50,000), so read the ordering, not the numbers. The YoY column is
bucketed the same way and returns only 0%, -90%, 900% or infinity in this
account. **Do not quote a YoY figure from this pull.** `usps shipping
calculator` shows -90% on 50,000 searches, which is bucket noise rather than a
collapsing market.

## Cluster totals

| cluster | midpoint | floor | terms | blank | >=50 | depth |
|---|---|---|---|---|---|---|
| size-tools | 71,150 | 14,230 | 12 | 2 | 10 | 83% |
| shipping-tools | 55,700 | 11,140 | 11 | 4 | 7 | 64% |
| code-lookups | 12,200 | 2,440 | 16 | 6 | 10 | 63% |
| listing-composer | 2,350 | 470 | 12 | 1 | 11 | 92% |
| care-decoders | 1,300 | 260 | 9 | 1 | 8 | 89% |
| comps-pricing | 1,250 | 250 | 10 | 3 | 7 | 70% |
| tax-books | 1,200 | 240 | 10 | 4 | 6 | 60% |
| inventory-ops | 1,100 | 220 | 7 | 3 | 4 | 57% |
| fee-math | 700 | 140 | 10 | 5 | 5 | 50% |
| photo-tools | 50 | 10 | 5 | 4 | 1 | 20% |
| condition-tools | 0 | 0 | 5 | 5 | 0 | 0% |

Depth is terms at or above 50 as a share of terms submitted, which is the ratio
form the 2026-08-18 note concluded the count-based threshold should have been.

## Concentration, which decides two of the three big clusters

| cluster | head term | head share | total without it |
|---|---|---|---|
| shipping-tools | `usps shipping calculator` 50,000 | **90%** | 5,700 |
| size-tools | `shoe size conversion chart` 50,000 | 70% | 21,150 |
| code-lookups | `rn number lookup` 5,000 | 41% | 7,200 |
| fee-math | `markdown calculator` 500 | 71% | 200 |

**Shipping fails the concentration test.** Strip the one term USPS itself owns
and the cluster is 5,700, which is marginal. The salvage is
`dimensional weight calculator` at 5,000, Low competition, 6.54 dollar bid, on
its own merits.

**Size survives it.** 21,150 across nine terms without the head, five of them at
5,000 each. That is a cluster, not a keyword. And `/tools/measurement-converter`
already exists, so this is deepening a shipped page rather than a new family.

**Code lookups survive it differently.** `rn number lookup` and `rn number
search` are 5,000 each and are the same page, so one tool carries 10,000 of the
12,200. The remainder is a real family: `nike style code lookup`,
`patagonia style number lookup`, `north face style number lookup` and
`lululemon style number lookup` at 500 each, plus `lululemon size dot decoder`
flagged as growing.

## The three findings worth more than the totals

**1. `rn number lookup` is the best single term in the pull.** 10,000 a month
across two phrasings, Low competition, and a top-of-page bid of zero, which
means no advertiser wants it and no SaaS is defending it. It is a database
lookup against the FTC register, so the answer is a fact from a table, which is
the one thing a craft blog cannot fake and an AI Overview has to cite a source
for.

The build is not greenfield. `functions/style/[code].ts`,
`functions/_shared/style-code-render.ts` and `sitemap-style-codes.xml` already
run this exact shape for Lululemon style codes, including the rule that only a
resolved code is indexable. An RN family reuses the template and needs data,
not architecture.

**2. Condition tools returned zero. All five terms, no data.**
`clothing condition chart`, `used clothing condition chart`,
`condition grade calculator`, `condition rating scale chart` and
`garment condition checklist` are blank. This is the third independent
confirmation that grading vocabulary has no search market: the July plan's
`graded clothing` at 70 a month, the glossary cluster's 0.33% CTR, and now a
tool-shaped cluster that does not exist as demand at all. Stop testing this
axis. Grading is the differentiator inside the funnel, never the front door.

**3. The seller-math clusters are weaker than the plan assumed.** Fee math is
700 and 71% of that is `markdown calculator`, a generic retail term. `reseller
tax calculator`, `ebay 1099 calculator`, `reseller break even calculator`,
`best offer calculator` and both consignment calculators are blank. Resellers
apparently do not search for their own math in these words. `ebay sales tax
calculator` at 500 is the only survivor worth a page.

## What the 185 suggestions added

Almost nothing new, and that itself is information. Planner expanded exactly one
seed, `ebay listing template`, into 30-odd near-duplicates: `ebay templates`
(500), `template for ebay description` (500), `ebay responsive listing template`
(500), then a long tail of 50s. Every other seed came back with no expansion,
which suggests these families are narrow rather than deep.

It does raise the honest listing-composer total to roughly 4,000 including the
tail, moving it from dead to marginal. The bids there are the highest in the
pull outside `sku generator`: 10.84, 8.09, 7.66, 6.84 dollars.

## Recommendation

Build order, and every one of these is gated on a SERP check of the head term
for an AI Overview before a line is written. That gate is now a build criterion,
per `docs/seo/serp-feature-audit-2026-08-28.md`.

1. **RN number lookup.** 10,000/mo, Low, no advertisers, reuses the style-code
   template, and it strengthens the brand-identification work rather than
   sitting beside it.
2. **Deepen the measurement converter into the size cluster.** 21,150 excluding
   the head term. Existing page, existing route, existing JSON-LD. Highest
   volume per hour of work in the file. SERP-check first: conversion tables are
   the shape Google answers itself, and `shoe size conversion chart` at 50,000
   is very likely an AI Overview plus Google's own widget.
3. **Brand style-number lookups.** Four brands at 500 each on the template that
   already ships for Lululemon.
4. **Dimensional weight calculator.** 5,000, Low, 6.54 dollar bid, one page.
5. **eBay listing template generator.** Marginal volume, best bids, cheap build,
   and it is a tool noun rather than a question.

Do not build: condition tools, photo tools, fee math beyond the sales-tax page,
consignment calculators, thrift and used-clothing price checkers.
