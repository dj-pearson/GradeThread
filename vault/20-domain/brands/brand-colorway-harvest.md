---
title: Harvesting brand colorways, and the two names every colour has to carry
aliases: [colorways, base_color, shade, colour buckets, house colour vocabulary, shopify harvest]
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00734_colorways_from_brand_catalogues.sql
  - supabase/migrations/00737_colorway_base_color_and_shade.sql
  - supabase/migrations/00738_colour_buckets_from_brand_facets.sql
  - supabase/migrations/00756_palettes_for_brands_that_had_none.sql
  - supabase/migrations/00758_colorways_from_product_titles.sql
  - supabase/migrations/00759_house_colour_vocabulary.sql
  - scripts/ops/brand-feed-probe.mjs
  - scripts/ops/shopify-brand-harvest.mjs
  - services/edge-functions/src/lib/aspect-normalize.ts
  - src/lib/aspect-normalize.ts
reviewed: 2026-09-10
tags: [brands, colorways, ebay, taxonomy, contract]
summary: A colorway earns its place by naming something the seller cannot name themselves, so it carries both the brand's word and eBay's bucket - and an unresolved bucket stays NULL, because a wrong "Brown" is a confident error that ships.
---

# Harvesting brand colorways

`brand_colorways` exists for one reason: **a colorway earns its place by naming
something the seller cannot name themselves.** "Spiced Chai" and "Maltese Blue"
are knowledge. "Blue" is not, and a table full of "Blue" looks covered while
helping nobody.

The rows come from each brand's own published catalogue, read by
`scripts/ops/brand-feed-probe.mjs` (which of the brands we hold publish a
readable feed) and `scripts/ops/shopify-brand-harvest.mjs` (read the ones that
do). The first sweep, in `00734`, measured the ceiling of the method:

    probed 184   feed 45   none 80   refused 15   skipped 40   error 4

Refused and none are **different facts and must stay separate**. A 429, a 503 or
a bot challenge is a moment in time; a missing feed is a property of the store.
`00761` retried the thirty recorded as "refused, retry" and recovered fifteen
brands that collapsing the two would have lost permanently.

## What gets seeded, and the one rule that is conditional

Three filters, all from `00734`:

- a colour must appear on **five or more products** — a house colour, not a
  one-off capsule;
- a brand must have **at least eight** such colours;
- **no more than 35% of them may be plain colour words.**

Case variants are one colorway. Several feeds carry "Black" and "BLACK" as
separate options; they fold, and the spelling on the most products wins.

**The 35% rule is conditional and `00756` says why.** Applied to forty brands
that had no palette at all, it rejected every one of them and the run produced
nothing. That rule decides whether a palette is worth *adding to a brand that
already has one*: if a feed offers little beyond Black, White and Navy, it tells
the listing writer nothing eBay's own Color list did not. Against **no** palette
the comparison is against nothing, and "this brand sells Black, White and Navy"
is a true and useful fact about its catalogue — one that also resolves to a
bucket perfectly. So `00756` drops that filter, keeps the other two, and records
the plain-word share per brand so the relaxation stays auditable.

## Every colour carries two names

From `00737`, in the owner's framing: "Optical White" belongs in the **title and
the description**, because it is what the brand calls the colour and what a buyer
searches. eBay's Color item specific will not accept it. That field wants
"White".

| column | what it is | where it goes |
|---|---|---|
| `color_name` | the brand's own name | title, description |
| `base_color` | the eBay Color bucket | item specifics |
| `shade` | Dark / Medium / Light | disambiguation, description |

The listing writer uses the first for prose and the second for the aspect, and
stops having to choose between being searchable and being valid.

**`base_color` is resolved through `aspect-normalize.ts`, never through a lookup
table inside a migration.** That file already carries `COLOR_FAMILY` and
`BASE_COLORS`, which is what the aspect normaliser has always used to narrow a
descriptive colour onto eBay's list, so resolving the KB through the same table
means the KB and the live publish path **cannot disagree**. A colour resolved one
way when seeding and another way when publishing is a bug that only surfaces on a
listing.

The resolver reads tokens **right to left and takes the last colour-bearing
one**. "Sage Green" is Green, not Sage.

## NULL beats a guess

`00737` left **1,013 of 2,294** colorways with no bucket. That is the correct
answer, not a gap: NULL makes the listing writer fall back to reading the
garment, while a wrong "Brown" is a confident error that ships.

The largest unresolved group is not a hole in the table. It is **denim**. 7 For
All Mankind's colours are wash names — Arizona, Belton, Cisco, Franklin, Kansas,
Hilo, Halona, Midtown, Milkyway. A wash name carries no colour information *by
design*; it names a finish. FRAME, Cotopaxi and Outdoor Research are the same
shape for the same reason.

## Three sources fill the gap, in increasing order of inference

### The brand's own facet tags (`00738`) — strongest

Brands namespace their filter facets in Shopify tags because their own site needs
a "shop by colour" filter, and the harvester was reading only `*style*:` tags and
walking past the rest. `wash::Brown` answers "Coffee Bean". `wash::White` answers
"Optical White". The brand knows and publishes it.

**Wash is a depth, not a colour.** "Dark Wash" is blue jeans that are dark, so it
becomes `base_color` Blue with `shade` Dark; Light Wash is Blue/Light, Mid and
Medium Wash are Blue/Medium — the same axis `00737` added, arriving from the
brand's own data instead of being inferred.

Ignored in that namespace: `Glitz`, `Metallic`, `Patent`, `Suede` and a bare
`Color`. They describe a **surface**, eBay has its own aspect for that, and
mapping "Metallic" onto a colour would put the wrong word in Color and lose the
right one. `Prints` and `Animal` **do** map, to Multicolor, because that is what
eBay's Color list offers for a patterned garment.

### House vocabulary added to the code (`00759`) — shared

What was left after `00738` was 6,004 names no table knew: Kalamata, Anthracite,
Sandstone, Oat. The obvious move was a lookup table inside the migration, and it
would have been wrong for the reason above. The vocabulary went into
`COLOR_FAMILY` instead, in both the edge and web copies of `aspect-normalize.ts`,
and the migration re-derives through it — so the live listing path gets the same
benefit at the same moment, whether or not the brand is in the KB.

**The words were counted, not brainstormed.** Every candidate was measured across
the 6,004 unresolved names first, and what earned a place is what several brands
use *independently*: "coffee" in 21 brands, "orchid" in 29, "heather" in 48. A
word one brand uses once is a per-brand fact and belongs in `brand_colorways`,
not in a table every listing reads.

> [!warning] Seven frequent words were deliberately left out
> `ice`, `garden`, `wild`, `vintage`, `clear`, `sea`, `mist`. Each is ambiguous
> alone: "Ice Blue" is blue but bare "Ice" is white-ish, "Sea Salt" is off-white
> and "Sea Green" is green. Because the resolver takes the **last** colour-bearing
> token, omitting a modifier lets the real colour win, while adding it makes the
> modifier win — which is worse than the NULL it replaces.

Result: 2,184 of 6,004 resolved. 3,820 still resolve to nothing and stay NULL,
and 104 of those picked up a *shade* with no colour to attach it to. The worst
remaining brands are single-brand house names with no shared vocabulary to
exploit, and only a per-brand decoder would move them.

### Product titles (`00758`) — weakest, and priced accordingly

`00756` found 76 held brands whose Color variant option is entirely **empty**
across enormous catalogues — Everlane over 8,879 products, Boden over 10,000,
American Giant, Allbirds, Blundstone. They are not colourless. They model each
colourway as its **own product**, so the colour sits in the title. An empty
palette for them means *this tool* could not read their colours, never that the
feed withholds them.

Title-derived rows carry **confidence 0.55; option-derived rows carry 0.75**, and
the gap is the point. A variant option is a **declaration** — the brand says this
product comes in Slate Blue. A title suffix is a **heuristic** — this tool decided
that whatever follows the last separator is a colour. Both can be right and only
one is stated.

Splitting titles on a separator produces confident garbage without five tests,
decided per brand:

| test | bar | what it stops |
|---|---|---|
| coverage | separator in >= 50% of titles | an accident in a few products |
| cardinality | >= 8 distinct tails | a repeated marketing suffix |
| shape | no size words, no style numbers, parentheticals stripped | "Natural Black (Dark Grey Sole)" |
| length | at most three words | Wax London's "Black Organic Cotton Twill Shorts" |
| resolve rate | >= 15% of tails resolve to a colour family | Ciele's tails, which are product lines |

The fifth test lives in the migration rather than in the harvester because it
needs the colour table, and the harvester deliberately knows nothing about eBay.

> [!warning] The 15% bar is the weakest rule in the set
> It is calibrated on exactly two examples. Ciele resolves at 0% and is a true
> negative (Athletics, Circle C, Century — short, varied, consistent, and not
> colours). Warp + Weft resolves at 23% and is genuine (JET BLACK, GARNET,
> INDUSTRIAL GREY, AMERICANO are real denim wash names, which is exactly the
> vocabulary this table exists to capture). A bar at 30% dropped it, so the bar
> is 15% — which separates the one true negative from the one true positive and
> nothing more. A product-line brand resolving at 20% would pass. **Widen the
> evidence before trusting this number.**

## What is never seeded

- **No hex values.** These feeds publish colour *names*, not values, and
  eyedropping a product photo is a guess wearing a fact's clothing (`00732`).
- **No size charts from a feed.** A feed gives the size *run*;
  `brand_size_charts` holds body measurements. See
  [[brand-kb-sizing-units]] and [[size-chart-coverage-backfill]].
- **No tag eras, country patterns or authentication tells.** A product feed
  cannot say when a neck label changed.

Every seeding pass touches only rows where `base_color IS NULL`, so nothing an
earlier pass derived is overwritten and a re-run changes nothing.

## Two things a reader will misread

**A brand row with no colorways is still worth having.** Across `00741` to
`00755`, dozens of brands were seeded with a KB row and an empty palette because
their feed publishes no Color option, or publishes colours that never recur
across five products. An empty colorway set means the feed does not say. It never
means the brand has one colour.

**The pack headers repeat themselves.** `00741` through `00746` each carry an
identical "REGISTERED NUMBERS: FIVE OF NINETEEN" block naming the same five
brands, which is a template that was not re-filled per pack. The colour lines at
the foot of each header *are* per-pack and are the accurate part. For registered
numbers, read [[brand-rn-attribution]] rather than those blocks.

## Related

- [[brand-rn-attribution]] — the other half of what these packs seeded
- [[brand-taxonomy-overview]] — why per-corpus rules live in notes and per-brand values in the table
- [[ebay-standard-size-values]] — the same "brand's word vs eBay's word" problem for size
- [[brand-kb-provenance]] — the source_url and confidence every seeded row carries
- [[INDEX]]
