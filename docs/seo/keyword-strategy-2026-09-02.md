# Keyword strategy, read from the 2026-09-02 data

Sources, all in `keyword/`:

- Search Console export `gradethread.com-Performance-on-Search-2026-09-02` (Web, "last 16 months", which in practice is 2026-06-06 to the end of August): `Queries.csv` (1,103 queries), `Pages.csv` (398 URLs), `Chart.csv`, `Countries.csv`, `Devices.csv`.
- Keyword Planner saved list of 2026-09-02 (158 terms: condition vocabulary, damage, marketplace trust, disputes, selling how-to). Not analysed before this note.
- Keyword Planner saved list of 2026-08-31 (107 tool nouns) and its 185 Planner suggestions (the eBay template family). Already read in `keyword-pull-toolnouns-2026-08-31.md`; reused here for the join.

Reading rules carry over from the earlier pulls: Planner volumes are buckets (50 / 500 / 5,000 / 50,000), so read the ordering and not the number, and the YoY column is bucketed too, so "growing" below means the bucket flipped, nothing more.

## 1. What Search Console says now

The site is still ramping, and the ramp has not slowed.

| Month | Clicks | Impressions |
|---|---|---|
| June 2026 | 0 | 16 |
| July 2026 | 12 | 2,104 |
| August 2026 | 118 | 13,919 |

Total to date: 130 clicks on 16,039 impressions, 0.81% CTR.

### Clicks come from one format

| Family | URLs | Clicks | Impressions | CTR |
|---|---|---|---|---|
| /tools | 13 | 48 | 1,455 | 3.3% |
| /blog | 137 | 46 | 8,099 | 0.57% |
| /compare | 16 | 13 | 2,302 | 0.56% |
| /care | 48 | 5 | 2,311 | 0.22% |
| /grading | 88 | 5 | 1,835 | 0.27% |
| /reselling | 12 | 2 | 711 | 0.28% |
| /condition-index | 31 | 0 | 259 | 0% |
| /value | 16 | 2 | 291 | 0.69% |

Thirteen tool pages out-click 137 blog posts. One of them, `/tools/authenticity-check`, holds 46 of the site's 130 clicks (35%) at 11.2% CTR from position 10.7. The next best CTRs on the site are also tools or tool-shaped: `/tools/fit-checker` 10.5%, the SKU-to-bin blog post 18.5% at position 3.9.

The August calculators are not in that number yet. `/tools/depop-fee-calculator` has 428 impressions at position 13 and no clicks; the eBay fee and shipping calculators sit at positions 33 and 47. Two weeks old, on commoditised SERPs. Judge them in October, not now.

### The clusters that already rank on page one and earn nothing

1. **Mercari partial refunds.** One blog post plus its anchor fragments and three sibling posts: about 2,960 impressions at positions 7 to 9, 10 clicks. The largest page-one cluster on the site. The queries are a dozen phrasings of "does Mercari do partial refunds".
2. **Vinted vs Mercari.** `/compare/vinted-vs-mercari` 1,182 impressions at position 8, 9 clicks, plus two blog posts. About 450 query impressions across nine phrasings. The comparison family's only page that converts.
3. **VGUC meaning.** 356 impressions at position 8.9, zero clicks. `/grading/glossary/vguc` has 510 impressions and one click. Google answers it in the result. Confirmed zero-click class, fourth time.
4. **Luxury resale apps.** `/blog/best-resale-apps-designer-luxury-clothing` 1,794 impressions at position 17.7, 5 clicks. The adjective-swapped assistant queries (`authenticated luxury resale platforms`, `trusted ...`, `reliable ...`) sit at positions 35 to 70 and are not winnable; `designer resale apps` at position 10 is.
5. **Marketplace pairs** (`mercari to grailed`, `grailed to poshmark`, 25 phrasings): about 300 impressions at positions 10 to 25, zero clicks. US-9018 shipped the answer on the comparison pages; US-9214 (one page per pair) is still open.
6. **Crosslisting head terms** (`cross listing software` 125 impressions at position 52, and 40 phrasings like it): page five. Diagnosed in `crosslisting-cluster-diagnosis.md`. Do not chase.

### Two facts about where the traffic is

- Mobile: 95 clicks on 8,870 impressions at average position 8.7. Desktop: 32 clicks on 7,062 at position 29. The site ranks three times better on phones, which is where resellers photograph and list.
- United States 65 clicks / 10,679 impressions; United Kingdom 11 / 1,542; India 11 / 339. The UK share matters for the Vinted point below.

## 2. What the 2026-09-02 Planner list says

158 terms, clustered by intent. Midpoint is the sum of bucket midpoints; blank means Planner returned no volume.

| Cluster | Terms | Blank | Midpoint | Med/High comp | Top bid | Read |
|---|---|---|---|---|---|---|
| Marketplace trust (`is X legit`, scams, return policy) | 9 | 0 | 171,000 | 1 | $56.01 | Biggest pool in any pull. Buyer intent. |
| Condition abbreviations (EUC, NWT, GUC, VGUC ...) | 36 | 11 | 143,900 | 1 | $2.45 | Polluted and zero-click. See below. |
| Selling how-to (`how to sell on depop`, thrifting, sourcing) | 23 | 4 | 23,900 | 2 | $20.00 | Real, Low competition, mostly consumer-adjacent. |
| Damage and care | 25 | 11 | 19,150 | 3 | $2.49 | Already Path 1. Care pages sit at positions 40 to 80. |
| Generic (`clothing resale`, `second hand clothes`) | 2 | 0 | 10,000 | 2 | $3.76 | High competition head terms. Skip. |
| Disputes and INAD | 23 | 11 | 2,400 | 0 | $0 | Dead as a cluster, second confirmation. |
| Listing craft, how-to phrasing | 14 | 9 | 700 | 2 | $0 | The how-to is blank; the tool noun is not. See section 3. |
| Grading vocabulary | 21 | 14 | 350 | 0 | $0 | Fourth confirmation. Stop pulling it. |

### The abbreviation number is two numbers

`euc` and `nwt` return 50,000 each and carry the only High competition and real bids in the cluster. EUC is also "end-user computing" and NWT is also the Northwest Territories, and those advertisers are who Planner is counting. Strip the two and the resale-only phrasings (`guc`, `nwot`, `nwt meaning`, `what does nwt mean on poshmark`, all in the 5,000 bucket) total about 44,000. The site already ranks for the shape at position 8.9 with a 0.2% CTR. There is nothing to build here; US-9017's title pass is the only lever and it is already written.

### Grading vocabulary, fourth time

`ai clothing grading`, `clothing grading app`, `condition grading app`, `clothing condition chart`, `clothing condition report`, `standardized clothing condition`, `how to grade clothes for resale`, `how thredup grades clothes`, `psa for clothes`, `certificate of condition`: every one blank or 50. This matches the July plan (`graded clothing` at 70), the glossary CTR, and the 2026-08-31 condition-tool pull. Grading is the differentiator inside the product. It is not a search front door, and no further pull should test it.

### Disputes, second time

`ebay buyer says not as described`, `false not as described claim`, `how to fight an ebay return`, `how to win an ebay dispute`, `how to prove item condition`, `proof of condition ebay`, `buyer lied about condition`, `ebay seller protection condition`: all blank. The four phrasings with volume are `item not as described` and its eBay, Depop and INAD variants at 500 each. One hub page, which exists. The Mercari partial-refund posts work for a different reason: Mercari's own help is bad and the question is procedural, not adversarial.

## 3. The two findings that are new

### Finding A: the how-to is blank, the tool noun is not

Same intent, two phrasings, opposite results.

| How-to phrasing (2026-09-02) | Volume | Tool-noun phrasing (2026-08-31) | Volume | Top bid |
|---|---|---|---|---|
| how to write a clothing listing | blank | ebay listing template | 500 | $4.93 |
| ebay listing description template clothing | blank | ebay description template | 500 | $7.66 |
| what to include in a clothing listing | blank | template for ebay description | 500 | $7.66 |
| how to describe clothing condition | blank | ebay responsive listing template | 500 | $0 |
| clothing listing template | blank | ebay title builder | 500 | $5.27 |
| mercari description template | blank | ebay keyword tool | 500 | $8.09 |
| depop description example | 500 | ebay selling templates | 50 | $10.84 |
| poshmark listing description | 50 | depop description template | 50, growing | $0 |

The listing-composer family is about 4,000 a month at midpoint, carries the best bids in either pull outside `sku generator`, and every incumbent is a static HTML template site from the Auctiva and inkFrog era (`free ebay templates 2022` is a query in the suggestions). The product writes the listing from a photo. A free page that does a limited version of that is not a template competitor; it is a different category of answer on the same SERP, and it is the most direct "our product is better than what ranks" fit in the whole file.

### Finding B: Vinted is the uncontested marketplace

Every Vinted term in every pull is Low competition with an index of 0 to 3, several flipped a growth bucket, and nobody in resale has written for the US audience yet because Vinted only opened there recently.

| Term | Volume | Competition | Top bid | Site today |
|---|---|---|---|---|
| is vinted legit | 5,000, growing | Low (3) | $21.67 | none |
| how to sell on vinted | 500, growing | Low (28) | $7.35 | none |
| vinted scams | 500, growing | Low (0) | $10.14 | none |
| vinted condition | 50, growing | Low (0) | | `/grading/platform-standards/vinted`, 119 impr, position 7.7 |
| vinted selling tips | 50 | Low (2) | | none |
| vinted dispute | 50 | Low (0) | | none |
| vinted vs mercari | (GSC: ~450 impr) | | | `/compare/vinted-vs-mercari`, position 8, 9 clicks |
| vinted vs poshmark | (GSC: 83 impr) | | | `/compare/vinted-vs-poshmark`, position 21.7 |
| vinted to mercari, mercari to vinted | (GSC: 53 impr) | | | comparison page, US-9214 open |

The site's best-converting comparison is the Vinted one, 11 of its 130 clicks come from the UK where Vinted is the default app, and the extension already cross-lists to Vinted (US-9202). The bids on `is vinted legit` and `vinted scams` say advertisers already value the reader. Six to eight pages own this marketplace before anyone else in the category notices it.

## 4. The largest pool, and why it is not the lead

`is depop legit`, `is mercari legit`, `is poshmark legit` at 50,000 each, `is vinted legit` at 5,000, plus `poshmark scam` 5,000 and the two return-policy terms at 5,000: 171,000 at midpoint, three of the four head terms Low competition, and the highest bid in any pull ($56.01 on Depop).

The August note dismissed `is poshmark legit` as unmonetisable. That was true when the site addressed sellers only. It is less true now: the buyer extension checks a listing's condition, the unified-extension decision gives buyers a reason to install, and a creator affiliate programme is a GO. "Is Mercari legit, and how do I buy safely" is a page whose honest answer ends at "check the listing before you pay".

It still is not the lead, for two reasons that the data cannot settle:

- The SERPs are almost certainly Trustpilot, Reddit, NerdWallet and the marketplaces themselves. That is an authority fight the calculators are meant to fund, not one to pick first.
- Buyer traffic does not pay a subscription. It installs an extension and, maybe, moves a certificate. Revenue per visit is unknown, and the site has no number for it yet.

The right move is a SERP gate, same as Path 1 got: read the top ten for the three 50,000 terms and the Vinted one. If a small blog holds a page-one slot on any of them, build four pages under a contained buyer hub and measure extension installs. If the top ten is all DA-80, park it and revisit when the domain has links.

## 5. What the data confirms without changing

- **RN and style-code lookups** (US-9029 to US-9036, step 3 of the style-code programme): `rn number lookup` plus `rn number search` is 10,000 a month, Low, zero bid, and the template already ships. Still the largest single Low-competition tool noun in any pull. Nothing here moves it.
- **Care cluster gate** (US-9019, US-9024): `/care/pilling` 344 impressions at position 73, `/care/mildew-odor` 244 at 66, `/care/pit-stains` 318 at 40. The 2026-09-02 damage terms add nothing the cluster does not already target. Hold the gate.
- **Size cluster** (US-3040, US-3041): `/tools/measurement-converter` 225 impressions at position 27.7, no clicks. `jeans size calculator` and `size chart converter` at 5,000 each are still the prize, still behind an AI-Overview check.
- **Comparison family**: the Vinted pair converts, the rest sit at page one with sub-1% CTR. The CTR pass (US-9017) is written and waiting on the operator run.
- **Marketplace how-to deflection** (Path 5): the Mercari partial-refund cluster is the proof it works when the marketplace's own help is bad. `how to sell on mercari` and `how to sell on depop` at 5,000 each, Low, are the next candidates, but they are held by Shopify-scale publishers and the marketplaces. Second wave.

## 6. The plan

Ranked by volume per hour of work, seller intent, and how contested the SERP is. Each leg has a kill condition.

### Leg 1: RN and style-code lookup (already scoped, ship it)

US-9029 to US-9036. 10,000 a month, Low, no advertisers, template exists, data pipeline shipped 2026-09-02. Kill condition: an AI Overview on `rn number lookup` that answers without citing. Check before US-9031.

### Leg 2: the listing generator as a free tool (new)

One page, `/tools/ebay-listing-generator` or similar, that takes a photo or a few fields and returns a title, item specifics and a description in the site's house style, capped per session, with the product as the "do this for your whole closet" step. Targets `ebay listing template`, `ebay description template`, `ebay title builder`, `ebay keyword tool`, `depop description template`, `poshmark listing template`. About 4,000 a month at midpoint, bids $5 to $11, incumbents a decade old.

Kill condition: an AI Overview that writes a template inline on `ebay description template`. SERP-check the three head terms first. Second kill: if the per-session cap cannot hold cost under the free-tool budget, ship the template half without the generator.

### Leg 3: own Vinted in the US (new)

Six to eight pages, mostly reusing shipped templates: `is vinted legit` (buyer-facing, the one exception to the seller rule, because the bid and growth are both there), `how to sell on vinted`, `vinted selling tips`, `vinted scams` and `vinted dispute` folded into one seller-safety page, a Vinted entry in the pair family (US-9214) pointing at the extension, and a refresh of `/compare/vinted-vs-poshmark` on the pattern that made `vinted-vs-mercari` work. About 7,000 a month at midpoint, every term Low.

Kill condition: Vinted's own help centre holding every page-one slot on `how to sell on vinted`. Check that one term.

### Leg 4: buyer trust, gated (new, not before the SERP check)

Section 4. Four pages, one hub, contained the way `/care` is contained (own sitemap segment, links out only). Build only if the SERP gate finds a reachable slot.

### Not building, and why

- Grading vocabulary: no demand, four pulls.
- Abbreviation pages: zero-click, pages exist, CTR pass is the whole lever.
- Dispute cluster: 2,400 with half the terms blank; one page exists.
- Generic head terms (`clothing resale`, `second hand clothes`, `faded jeans`): High competition, no product fit.
- More care pages: gated on `/care/pilling` reaching page one.
- Crosslisting head terms: diagnosed, page five, vendor pages cannot rank there.

## 7. What to measure

- Leg 2 and 3 pages: impressions and CTR at four weeks and eight weeks, mobile and desktop split (the site ranks three times better on mobile).
- Extension installs from any buyer-facing page, before Leg 4 gets a second page.
- The `[listing-tag-metric]` line and the aspect-fill report for Leg 1, per the style-code memory.
- US-9028 first: the reporting window. Every number in this note is a June-to-August average over a site that did 118 of its 130 clicks in August.
