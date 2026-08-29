# Keyword pull 2026-08-28: what it changes, and what it does not

Second Keyword Planner pull, 651 keywords, run 2026-08-28 against the
Aug 2025 - Jul 2026 window. Raw file `keyword/Keyword_Stats.csv` (UTF-16,
tab-separated, as Planner exports it). Normalised into the same shape as the
first pull at `docs/seo/keyword-pull-2026-08-28-results.csv`.

**It overlaps the 2026-08-18 pull by exactly one keyword.** The two are
complementary, not a re-run. The first pull sized stain removal, repair, fee
calculators and shipping. This one sizes pilling, vintage tee dating, eBay sold
comps, reseller spreadsheets and listing photography.

Paired with the Search Console export of the same date
(`keyword/gradethread.com-Performance-on-Search-2026-08-28/`, 94-day window,
14,128 impressions, 103 clicks).

---

## 1. The finding that outranks the keyword file

Before any of the new clusters are worth arguing about, the per-family Search
Console numbers settle a question the site has been avoiding. Per month, over
the 94-day window:

| family | URLs | impr/mo | clicks/mo | CTR | weighted position |
|---|---|---|---|---|---|
| /blog | 122 | 2,095 | 12.3 | 0.59% | 11.7 |
| /compare | 16 | 633 | 3.5 | 0.56% | 10.8 |
| /care | 46 | 494 | **0.6** | 0.13% | 42.4 |
| /grading | 87 | 492 | 1.6 | 0.33% | 8.6 |
| **/tools** | **10** | **364** | **12.6** | **3.46%** | 20.6 |
| /reselling | 12 | 179 | 0.3 | 0.18% | 42.5 |
| /value | 15 | 88 | 0.6 | 0.74% | 6.5 |
| /condition-index | 29 | 59 | **0** | 0.00% | 8.1 |

Ten tool URLs earn as many clicks as a hundred and twenty-two blog posts.
Their CTR is six times the site average.

Meanwhile 162 URLs across /care, /grading and /condition-index produced
**seven clicks in three months**. /grading is the sharpest version of it: 87
URLs at an average position of 8.6, which is a good position, converting at
0.33%. The pages rank. Nobody clicks them.

The reason is visible in the query data. `vguc meaning` earns 355 impressions
at position 8.9 and zero clicks. `what does nwot mean` is the same shape.
Definition queries get answered above the results now, and a 321-word page
whose promise is the definition has nothing left to offer. That is not a
ranking failure and no amount of new glossary pages fixes it.

**So the format is the strategy, not the topic.** Tools convert. Definitions do
not. Anything this keyword file justifies building should be built as a tool or
a workflow page, and only as an article when there is genuinely no tool in it.

## 2. The clusters in the new pull

Ordered by monthly volume, with the verdict.

| cluster | kw | vol/mo | competition | existing coverage | verdict |
|---|---|---|---|---|---|
| pilling / lint / fuzz / bobbles | 447 | **152,400** | mostly High | `/care/pilling` at **position 72** | Deepen. Do not expand. |
| single stitch tee dating | 25 | 8,850 | High | **none** | Build. Best on-brand gap. |
| how to check sold items on eBay | 14 | 7,250 | **Low** | none | Build as a tool. |
| how can I sell clothes | 4 | 5,050 | Medium | `/reselling/how-to-sell-used-clothes-online` | Leave. |
| what does NWOT mean | 1 | 5,000 | **Low** | `/grading/nwot`, 342 words | Reframe, do not expand. |
| photographing clothes to sell | 28 | 3,450 | **Low** | none | Build. Feeds FlipDesk. |
| yellowed shoe soles | 36 | 1,750 | mixed | none | **Skip.** Off-entity. |
| Mercari / Depop / Poshmark vs | 7 | 1,700 | Low | `/compare/*` (16 pages) | Already served. |
| reseller inventory spreadsheet | 13 | 1,600 | High, **$21.71 top bid** | none | Build. Highest commercial intent in the file. |
| pricing used clothes | 4 | 150 | Low | `/whats-it-worth` | Leave. |

### Pilling is 92% of the file's volume and it is a trap in its current form

152,400 searches a month is the largest single cluster either pull has
surfaced. `/care/pilling` already exists, targets the head term in its title,
and sits at **position 72 on 203 impressions with zero clicks**. It is 665
words with no images.

The head terms are High competition and the SERP wants a long illustrated
how-to with product recommendations. A 665-word page is not losing on domain
authority, it is losing on being a third of the size of everything above it.
US-9011 already established the repair space is held by small craft blogs
rather than major publishers, so the space is reachable. The page has simply
never been given enough to rank with.

**Building the other 400 pilling long-tails before the head page can hold
page two would be building 400 more position-70 URLs.** The care family is
already the worst-performing family on the site at position 42.4 across 46
URLs. Volume this large is a reason to make one page real, not a reason to
make forty thin ones.

### The SERP measurement, and the thing it found that changes the odds

Measured in a browser on 2026-08-28 while building US-9019, rather than
estimated. Article-body word counts on the reachable results:

| result | words | images | structure |
|---|---|---|---|
| Patagonia (brand blog) | 1,351 | 6 | prose guide |
| Vogue | 1,211 | 10 | tool comparison |
| Gentleman's Gazette | 1,022 | 10 | **9 methods ranked, summary table** |
| `/care/pilling` (before) | 665 | 0 | one method, prose |

Two useful findings and one uncomfortable one.

The field is **shorter than expected**: 1,000 to 1,350 words, not the 1,800 the
story assumed. What separates the winners is not length, it is that two of the
three are built as a **ranked method comparison**. A reader on this query is
choosing between tools, not looking for one.

The uncomfortable finding: **that SERP carries an AI Overview, a People Also
Ask block and a video carousel, and returns only seven organic blue links**,
two of which are Reddit and a Facebook post. This is the same shape that is
already suppressing `/grading`, where 87 URLs sit at position 8.6 and convert
at 0.33%.

So US-9019 can succeed on its own terms and still earn very little. That is
why the gate now requires **both** position 20 or better **and** a click-through
rate above 1.0%, rather than position alone.

The US-9016 threshold for /care is 10,000 impressions/mo by 2027-02-18. It is
at 494. That needs a twentyfold increase from 46 URLs, and the honest read is
that it arrives from three pages that actually rank or it does not arrive.

### Single stitch is the cleanest gap in the file

8,850/mo across 25 keywords, and the site has **zero pages** on it. Single
stitch is how resellers date a vintage tee to pre-1994, which makes it an
authentication question, and `/tools/authenticity-check` is the best page on
the site by a distance: 37 clicks, 337 impressions, **10.98% CTR**. The
audience and the format are both already proven here.

### eBay sold comps is the best volume-to-difficulty ratio

7,250/mo at **Low** competition. Every other cluster with volume near this is
High, so it is the best ratio in either pull, and the format that converts on
this site is the format the query wants.

**Corrected after building it.** This section originally said "the product
already does it, FlipDesk has the eBay Browse comps integration wired". Browse
returns *active* listings. The sold half of that sentence was never true here:
`EBAY_MARKETPLACE_INSIGHTS` has never been granted. See §4.

### The spreadsheet cluster is small and worth more than its volume

1,600/mo is nothing next to pilling. But the top-of-page bid is **$21.71**,
which is the highest in either pull, and the searcher is a reseller looking for
the thing FlipDesk replaces. A free download that runs out of room is the
oldest funnel there is and it is honest here, because spreadsheets genuinely do
run out of room. `/blog/when-should-resellers-stop-using-spreadsheets-inventory`
already exists and gets nothing, because it argues the point instead of handing
over the file.

### Skip the shoe soles

1,750/mo, and it is sneaker restoration. Nothing in it grades a garment.
US-9015 exists precisely to stop the care cluster diluting the reseller entity,
and this is what that guard was written for.

## 3. What this does not change

The CTR pass, US-9017, is still the cheapest work in the file and still has two
open operator items: the prod `--apply` for the seven blog rows, and the
2026-10-17 Search Console read. Nothing in this pull outranks finishing that.

Keep the size honest. Closing the whole CTR gap is worth roughly 66 clicks over
six months. Everything proposed here is a bet on the next two quarters, not a
fix for this month.

## 4. Stories filed, and what shipped

All six were built on 2026-08-28. A seventh was found while building the first.

| story | what it is | state |
|---|---|---|
| **US-9021** | `/tools/ebay-sold-listings` | shipped |
| **US-9020** | `/tools/single-stitch-dating` | shipped, less the hem photographs |
| **US-9022** | `/tools/reseller-inventory-spreadsheet` | shipped, less the Sheets copy link |
| **US-9023** | `/tools/photograph-clothes-to-sell` | shipped |
| **US-9019** | `/care/pilling` deepened | shipped, less the before/after photograph |
| **US-9024** | the gate on pilling expansion | filed, dated 2027-02-18 |
| **US-9025** | stop claiming FlipDesk reads eBay sold data | fixed |

### The correction that shaped US-9021

The story asked for a page returning sold comps. **The platform has no source
of realized sold prices.** `EBAY_MARKETPLACE_INSIGHTS` has never been granted,
so `searchSoldComps()` returns null before it opens a socket, and the only eBay
prices reachable here are active asking prices. Printing those under the word
"sold" is exactly the defect `value-disclosure.ts` exists to prevent.

What shipped instead hands the visitor eBay's own sold results, built on the
same three rungs `comps-ladder.ts` uses. No endpoint, no fetch, no credential
exposed to public traffic, and it is a better answer to the query that was
actually typed.

### US-9025 came out of checking that

Seven marketing surfaces claimed FlipDesk pulls eBay sold comps. A grep found
five; the guard test written for it found seven. The correction is not deleting
the word: `getRealizedComps` has two sources and only the eBay one is
ungranted, so the copy now says comparable eBay listings, which are asking
prices, switching to the seller's own realized sales at three.

The guard's first cut failed four sentences that were **telling the truth**:
"look up what comparable items actually sold for" is correct advice. The
pattern has to be about the claim (product as subject), never the word.
