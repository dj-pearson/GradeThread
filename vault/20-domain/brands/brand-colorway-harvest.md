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
  - scripts/brand-colorway-gap.mjs
  - scripts/fixtures/brand-demand-prod-2026-08-26.txt
  - services/edge-functions/src/lib/aspect-normalize.ts
  - src/lib/aspect-normalize.ts
reviewed: 2026-09-11
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

### The NULL count is a CONSEQUENCE of the harvest, not a second gap

Added 2026-09-11 (US-3127), because "3,820 buckets stay NULL" and "267 brands
have no palette" get read as one problem and they are on different axes: the
first counts **rows inside brands that DO have a palette**, the second counts
**brands**. Neither can be derived from the other.

And the direction matters. Follow the same two numbers through the packs:

| after | rows | NULL bucket | NULL share |
|---|---:|---:|---:|
| `00737` | 2,294 | 1,013 | **44.2%** |
| `00758` | 17,311 | 6,004 | 34.7% |
| `00759` | 17,311 | 3,820 | **22.1%** |
| `00761` | 17,813 | 4,067 | 22.8% |

The absolute count rose 3.8x and the share **halved**. At 159 rows the largest
NULL count arithmetically possible was 159; the figure grew because the table
grew 112x, and it grew more slowly than the table did. A bigger NULL count here
is evidence the resolver is winning, not losing.

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

## How much is covered, and which number answers which question

Added 2026-09-11 (US-3127). Three different numbers get quoted as "colorway
coverage" and they measure three different things. Ask which one before quoting
any of them.

| question | unit | measured |
|---|---|---:|
| how big is the table? | rows | **17,813** |
| how many brands have a palette? | brands | **282 of 549** (51.4%) |
| how many colour rows resolve to an eBay bucket? | rows | **13,746 of 17,813** (77.2%) |

`scripts/brand-colorway-gap.mjs` is what asks these, and it is the colorway side
of the join `scripts/brand-kb-gap.mjs` already does for `brand_knowledge`,
matching on `brand_key`, `canonical_brand` AND `aliases`, reusing the same SQL
scanner and the same NOT-A-BRAND classification. The verdicts differ because the
questions do: that script asks whether the KB knows the brand, this one asks
whether it knows its colours, so a brand is routinely COVERED there and
NO-PALETTE here.

> [!warning] A row count is the wrong unit and "frozen at 159" was already stale when it was filed
> US-3127 was written from a prod count of 159 rows taken on 2026-09-06. `00734`
> was applied to prod the same day and `00761` two days later. The story's whole
> premise had been answered before anybody read it, which is the argument for a
> script over a typed query: a number nobody can re-ask gets quoted forever.

### The gap ranked by what sellers hold, which is the only ranking worth having

Scored against `scripts/fixtures/brand-demand-prod-2026-08-26.txt`, which is the
top 20 brands by `inventory_items` count, transcribed from the prod run US-2922 AC1
made. **Read that file's denominator before quoting a percentage from it**: 20
brands out of 100 ranked, 132 items out of 711 scanned. It is the head, not the
platform.

    NO PALETTE   14 brands, 106 items   KB row exists, zero colorways
    THIN          2 brands,  14 items   1..7 colorways, below 00734's own bar
    COVERED       3 brands,  13 items   8+
    NO KB ROW     1 brand,    5 items   L'AGENCE -- a brand-kb-gap.mjs problem

So **17 of the top 20 brands sellers hold are not usefully covered**, against
51.4% of the KB overall. The harvest went where the feeds were, and the feeds are
not where the demand is.

### The 35 THIN brands are all the same 35 brands, and that is the finding

Every brand with 1 to 7 colorways was hand-seeded before `00473` and **not one
was ever re-harvested**. 39 brands still carry nothing but those hand-written
rows: 155 of the corpus's 17,813. They are the residue of the original 159, and
they are the worst rows in the table by the table's own rule: J.Crew's single
colorway is a plain colour word, Free People's two both are.

`beyondyoga` is the only brand from that cohort a later pack revisited (99
colorways from `00758`). The others look covered in a `count(distinct brand_key)`
and are not.

**The 38 rows carrying a `hex` are all from that cohort too**, across thirteen
packs from `00390` to `00465`, and no harvested row carries one. The
no-hex rule in "What is never seeded" was written at `00732`; everything before
it predates the rule. Those values were not published by the brands.

## Why it stopped at 159, and what that proves about a recorded refusal

Also US-3127, and the question had to be answered before adding a single row:
**did colorways stop because a sourcing rule refused them, or because the pack
template quietly dropped the table?** `registered_numbers` covers a minority of
brands and that is a decision, so low coverage in this KB is not self-evidently a
gap. Here it is.

Rows contributed per migration, cumulative:

    00390 .. 00472   159 rows over 23 brands   the hand-written era
    00473 .. 00729     0 rows over  0 brands   257 migrations, ~300 brands added
    00732 .. 00761  17,654 rows over 260 brands   the catalogue harvest

The cumulative count crosses 159 at `00472` to the row. **From `00473` to
`00729` not one migration seeded a colorway and not one recorded a colorway
decision**: no refusal, no "no palette found", nothing. The only two mentions in
that whole range are incidental: `00576` uses the word in prose about decoders,
`00578` names the table in a constraint. So the omission is **incidental, a
pack-shape habit**, and this is a backfill rather than a documented refusal.

### But the hand-written era DID record refusals, and reading the catalogue overturned one

This is the part worth keeping, because it is the more useful half:

- `00456` refused Supreme, Stüssy, Kith and Palace, because "their colors are per-drop
  and plain (red, black), so there is nothing proprietary to seed".
- `00459` refused the three packs before it on the same ground, and named the
  contrast: a shoe ships a small stable named palette that buyers search by name,
  "UGG Chestnut is a real search and Anthropologie Sage is not".
- `00461` refused Dior, Saint Laurent, Balenciaga, Fendi, Versace and Céline,
  keeping only Hermès and Bottega Veneta.

Those were real judgements and they were honestly recorded. They were also made
**from memory rather than from the brand's catalogue**, and `00758` falsified one
of them by reading Kith's: **398 colorways, 6% plain colour words.** A refusal
sourced from what an author could recall about a brand is a different object from
one sourced from the brand's own published data, and only the second kind
survives somebody looking.

⚠ `00459`'s header says `00456` "seeded none". It seeded nine, BAPE's named camo
patterns and Fear of God Essentials' season colours. The claim is wrong about one
of the three packs it names.

## The feed method has hit its ceiling, and it hit it exactly at the demand

Measured 2026-09-11 (US-3127) by probing all 16 head brands with
`scripts/ops/brand-feed-probe.mjs` and then by hand. **Zero answered
`/products.json` with a feed.** The Shopify harvest read 260 brands and cannot
read the ones sellers actually hold.

One exception, and it is a method extension worth having:

> [!warning] A headless Shopify brand hides its feed on `<store>.myshopify.com`
> `vuoriclothing.com/products.json` is a **404**. `vuori-clothing.myshopify.com/products.json`
> serves the feed. Vuori runs a Next.js storefront over a Shopify backend, and
> the canonical `myshopify.com` domain is asserted in the storefront's own HTML,
> so it is discoverable, first-party, and the probe's origin rule never tries it.
> **Sweep the storefront HTML for `*.myshopify.com` before recording "no feed".**
> Of the other 15 head brands, none carries one, so this is not a general escape
> hatch; it is one brand, and it happens to be rank 1 by item count.

### The second method: JSON-LD `color` on a product page

Some brands publish `"color"` inside a PDP's `application/ld+json` block. That is
the same class of source as `/products.json`, a documented published format
reached through the site's own `robots.txt` sitemap, and it works where the
Shopify endpoint does not. It is **slower and dirtier**: one colour per product
rather than a variant option list, so the "five or more products" rule needs the
whole catalogue walked, and the field mixes real house names with print names and
truncated codes ("Dstn Strp/Lobster Rf", "Vineyard Ss Pb/Wc").

It also fails a test the feed method never had to state: **the field can be the
site's colour FACET rather than the brand's colour NAME.** Measured on 25 product
pages each —

| brand | distinct names | plain colour words | verdict |
|---|---:|---:|---|
| Vince | 18 | 1 (5.6%) | house names: ECLIPSE, BEACH STONE, COCOA BROWN |
| GANT | 8 | 8 (**100%**) | a filter bucket. Refuse. |
| Banana Republic | 15 | 15 (**100%**) | a filter bucket. Refuse. |

A palette of blue/black/red passes no test this table has and tells a listing
writer nothing eBay's own Color list did not. Sample before walking a catalogue.

### The refusals, with the test each failed

All 2026-09-11, all re-checkable. **Refused is not the same as none.** The last
three are a moment in time and `00761` recovered fifteen brands that collapsing
the two would have lost permanently.

| brand | items | test it failed |
|---|---:|---|
| Peter Millar | 12 | Imperva block page served as **HTTP 200** with a 6,183-byte body. Recorded in `00730`; reconfirmed. |
| Carhartt | 7 | `/products.json` 404; PLP HTML carries no colour; PDP `ld+json` has no `color`. |
| GANT | 7 | Publishes `ld+json` `color`, and it is **100% plain colour words**. A facet, not a palette. |
| prAna | 8 | 404, no PLP colour, PDP `ld+json` has no `color`. |
| Bonobos | 7 | Same three. Still on its five hand-seeded rows from `00467`. |
| Polo Ralph Lauren | 7 | 404; the storefront answers 307/404 to automation; sitemap yields no product page. |
| Banana Republic | 6 | `ld+json` `color` is **100% plain**. Same verdict as GANT. |
| Lauren Ralph Lauren | 6 | Sitemap yields no product page. |
| Ermenegildo Zegna | 6 | 404; 55 sitemaps, 24 fetched, no product page found. |
| Quince | 5 | 404; sitemap yields no product page. |
| Patagonia | 7 | `/products.json` **410**; the product page from its sitemap 404s. Still on four hand-seeded rows. |
| Christian Dior | 4 | **refused, retry**: 503 on the feed, 403 on the storefront. |
| Mizzen+Main | 4 | **refused, retry**: 429. Already recorded as throttling in `00731`. |

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
