---
title: SEO strategy options (Aug 2026 reset)
type: decision
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-09-01
revisit_by: 2026-11-18
tags: [seo, geo, strategy, growth, options]
summary: Eight candidate paths for a new SEO strategy after the grading-first plan failed to produce traction, scored against the 2026-08-18 Keyword Planner pull, which cleared the damage-and-care and calculator paths and killed the returns spine.
---

# SEO strategy options (Aug 2026 reset)

The July 2026 plan ([[seo-geo-strategy]]) bet on category creation: own
"clothing condition grading" because nobody else does. Thirteen months of
build later the surface is large and the traffic is not. This note lays out
what to do instead.

It does not retire [[seo-geo-strategy]]. Parts of that plan are still right,
and the assets it produced are reusable. What changes is which universe sits
at the front of the funnel.

## What actually got built

Worth being precise, because the honest read is that execution was not the
problem.

- 46 hand-registered public routes plus ten generated families in
  `src/lib/seo/`, about 10,100 lines of route and content data.
- 47 reseller glossary terms, 35 flaw pages, 35 garment guides, 12 platform
  standards pages, 9 reselling guides, 6 FlipDesk landing pages, 5 competitor
  alternative pages, 4 comparison guides.
- Fifteen sitemap segments in `functions/`, covering certificates, passports,
  leaderboards, durability, value, finds, condition index, help, blog,
  authors, images.
- Prerendered static HTML, edge-SSR for dynamic surfaces, JSON-LD per route,
  a keyword-target registry with a CI test that fails when copy drifts from
  its target, an interlinker, a freshness system and an llms.txt.

That is more technical SEO than most funded startups ship. The pages are
crawlable, structured and internally linked. If those pages had demand behind
them, they would be ranking.

## The diagnosis has to run before the decision

Three causes produce "no traction", and they need opposite responses. Picking
a new content strategy while the real cause is cause 2 or 3 wastes another
quarter. All three are separable in Search Console in about half an hour.

**Cause 1: no demand.** The pages are indexed, they get impressions in the
single digits, and the queries behind them are the grading terms that came
back blank in the original Keyword Planner pull. Response: change the
universe. That is what the paths below are for.

**Cause 2: no indexation.** Go to Search Console, Pages, and read the
indexed-versus-discovered split per sitemap segment. If a large share of the
generated families sit in "Crawled, currently not indexed" or "Discovered,
currently not indexed", Google has judged the templates thin and is declining
to store them. Response: consolidate. Fewer, deeper pages, and stop adding
families. New content on a domain already carrying hundreds of unindexed
templated URLs gets crawled slower, not faster.

**Cause 3: no authority.** The pages are indexed, they get impressions, and
average position sits past 20 on every query. That is a link and entity
problem, not a content problem. Response: [[authority-machine-activation]]
and the off-page section of [[seo-distribution-and-measurement]], not a new
content universe.

Read the three numbers first: total impressions last 90 days, indexed page
count per sitemap segment, and average position on any query with more than
50 impressions. They separate the causes cleanly.

The kill criteria in [[seo-distribution-and-measurement]] anticipated exactly
this moment. Under 1,000 grading-cluster impressions per month at six months
was the stated trigger to stop investing in the moat. Honor it.

## The diagnosis, run (2026-08-18)

US-9001 is closed. Source: the Search Console export in `keyword/`, Web search,
2026-05-25 to 2026-08-16. Full working in `docs/seo/US-9001-VERDICT.md`.

**Verdict: none of the three causes. The premise above is wrong.**

The site is not flat. It is ten weeks into a normal indexation ramp and
compounding: first impression 2026-06-06, 2 impressions in the week of June 1,
**2,410 in the week of August 10**. Six-month totals are 6,434 impressions and
55 clicks across 270 URLs and 366 queries.

- **Cause 1, no demand: failed.** 6,434 impressions and accelerating.
- **Cause 2, no indexation: failed.** 270 URLs earn impressions. `/sitemap.xml`
  is a flat 519-URL urlset exactly equal to the union of all 15 segment
  sitemaps, no orphans. The four spot-checked URLs are 200, self-canonical,
  `index, follow`, in the sitemap.
- **Cause 3, no authority: failed.** 156 of 270 URLs rank in the top 10.

**The real cause is a fourth one nobody listed: ranking without clicks.** 149
URLs sit at position 3-10 and convert at 0.85%, against a 3-10% baseline. The
query `vguc meaning` returns 355 impressions at average position 8.88 and zero
clicks.

Three findings that change the plan:

1. **Definition pages are a zero-click class.** Nineteen glossary pages earn
   1,087 impressions between them and 4 clicks. Google answers "what does VGUC
   mean" in the SERP. Deprioritise anything glossary-shaped.
2. **Tool pages already win by 10x.** `/tools/authenticity-check` earns 9.0% CTR
   at position 13.4, against a 0.85% site average, and out-clicks 104 blog posts
   sitting at position 8. This is local evidence for Path 3, stronger than the
   Keyword Planner numbers Path 3 was originally argued from.
3. **The Planner buckets are unreliable.** Three of the four URLs US-9001 named
   as proven 5,000/mo demand (`/grading/glossary/euc`, `nwt-vs-nwot`,
   `pre-owned`) have never had a single impression. Treat the 50,000/mo behind
   `ebay fee calculator` with the same suspicion.

Nothing is blocked. Build order stands, with a cheap CTR copy pass in front of
it (`docs/seo/ctr-rewrite-worklist.csv`, 19 URLs, worth about 66 clicks over six
months, which roughly doubles a small number). Path 3 is confirmed as the bet.

Correction to the backlog: US-9008 claimed the comparison family holds only
`mercari-vs-ebay`. There are 16 live `/compare/` URLs, and both pages that story
asked to create have existed since 2026-07-06. It has been rewritten to fix them
rather than build them.

## The eight paths

Ranked by expected traffic per unit of build effort, given what already
exists. Each names what would kill it, because a path without a kill
condition is a hope.

### Path 1: the damage and care universe

> [!success] Cleared the pull: 295,750 midpoint, 42 of 55 terms above 50. Lead with it, starting with the repair sub-cluster.

**The bet.** People do not search for how to grade a flaw. They search for
how to get rid of one. "How to remove a deodorant stain from a shirt" is a
question millions of people ask; "how to disclose a deodorant stain in a
listing" is a question a few thousand resellers ask. Same 35 flaws, opposite
door.

**Why it is the strongest option.** The flaw library already exists as
structured data covering pilling, sun fading, moth holes, pit stains,
crocking, shrinkage, color bleeding, mildew odor and 27 more. Each entry
needs a removal and prevention section added ahead of the disclosure section,
and the page title reframed from grading language to removal language. The
route registry, JSON-LD, prerender and interlinker all carry over untouched.
This is an edit to `src/lib/seo/flaw-library.ts` and its page template, not a
new family.

**The multiplier.** Flaw crossed with fabric is a real matrix, not a fake
one, because the answer genuinely differs. Removing an oil stain from silk is
not the same procedure as from cotton denim. Thirty-five flaws crossed with
the eight or ten fabrics that behave differently gives a few hundred pages
where every page has a distinct correct answer. That is the test a
programmatic family has to pass, and this one passes it.

**The connection to the product.** Every removal page ends at the same place:
some damage does not come out, and then you have to price and describe it
honestly. That is the grading pitch, delivered to someone who arrived with a
garment problem rather than a software problem.

**What kills it.** If the pull shows the removal terms are dominated by
Tide, Persil, Good Housekeeping and Martha Stewart at domain authority 80
plus with no gaps below position 10, this becomes a two-year fight. Check the
actual SERP for five terms before committing, not just the volume column.

### Path 2: the returns and dispute spine

> [!failure] Killed by the pull: 950 a month once the one off-topic term is stripped, 21 of 32 terms blank. Do not build this cluster.

**The bet.** This is the hypothesis in the original question, and it is a good
one. A seller whose buyer just filed "item not as described" is in acute pain,
searching in plain language, and the product is literally the answer: a
timestamped condition report is evidence.

**What exists.** One page, `/reselling/reduce-ebay-returns`, built as the
designated crossover between the reselling and grading universes. It is a
spine with nothing on it.

**What it becomes.** A cluster of 25 to 40 pages covering the dispute
lifecycle: what SNAD means, how to respond to a case, how to fight a false
claim, who pays return shipping, what happens when a buyer damages the item
and returns it, how returns affect seller standing, how to appeal, what
photos count as evidence, how to write a description that survives a case.
Same structure for Poshmark, Mercari, Depop and Vinted, where the policies
differ enough to justify separate pages.

**Why it converts better than anything else here.** The searcher is a seller,
mid-transaction, with money at stake, and the thing that would have prevented
their problem is the thing you sell. Traffic per page will be lower than
Path 1. Revenue per visit will be higher.

**What kills it.** If eBay's own help pages and the community forums hold
every position on the first page. Marketplace-policy queries often resolve to
the marketplace. Check whether third-party sites rank at all before building
the cluster.

### Path 3: free calculators and tools

> [!success] Cleared the pull: 128,700 midpoint, and `ebay fee calculator` pairs 50,000 searches with a 13.23 dollar bid. Promoted to co-lead.

**The bet.** There is not a single calculator on the site. Fee calculators,
profit calculators and measurement converters are the highest link-per-hour
asset in this category, they rank on transactional intent, and they are a
weekend of work each on this stack.

**The list.** eBay fee calculator, Poshmark fee calculator, Mercari fee
calculator, Depop fee calculator, reseller profit calculator, cost-of-goods
and mileage tracker, clothing measurement converter, international size
converter, shipping cost comparison.

**Why it matters beyond traffic.** Tools earn links from Reddit, YouTube
descriptions and reseller blogs without any outreach. Backlinks are the
cause-3 problem, and this is the cheapest legitimate way to fix it. If the
diagnostic comes back as cause 3, this path stops being optional.

**The product hook.** A profit calculator that asks for condition to estimate
sale price is a grading demo that does not feel like one.

**What kills it.** Nothing much. Even at modest volume the link acquisition
justifies it. This is the lowest-risk item on the list, which is why it
should ship regardless of which other path wins.

### Path 4: resale value pSEO

> [!failure] Killed by the pull: 1,400 midpoint, 7 of 17 terms blank.

**The bet.** "What is this worth" is the largest evergreen query pool in
resale, and the site already has a `/value` sitemap segment and a comps
feature inside FlipDesk feeding real sold data.

**The shape.** Brand crossed with garment type crossed with condition:
what a Carhartt Detroit jacket in good condition sells for, and the same for
a few thousand combinations that actually have comp data behind them.

**The honest risk.** This is the most competitive pSEO pool in the category
and the incumbents are strong: eBay's own sold listings, WorthPoint,
PriceCharting-style aggregators and Google Shopping. Thin value pages are
also the exact template Google's helpful-content passes target. If the
diagnostic returns cause 2, do not build this.

**Where it does win.** Nobody else can answer the condition axis with
evidence. "What is a Carhartt jacket with a broken zip worth" is a question
eBay cannot answer and you can. Build the condition-differentiated slice, not
the generic one.

**What kills it.** Comp coverage. If fewer than a few hundred combinations
have enough real sold data to state a number honestly, the family cannot be
built without inventing numbers, and that is not on the table.

### Path 5: marketplace how-to deflection

> [!note] Marginal: 9,900 midpoint, but three of its terms are flagged as growing. Second wave.

**The bet.** eBay and Poshmark's own help documentation is bad, and sellers
search around it constantly. "How to relist on eBay", "eBay item specifics",
"how to cancel an offer", "how to change a listing after it has bids".

**The evidence already in hand.** The original pull recorded `ebay item
specifics` at 70 a month and growing 425 percent year over year, on Low
competition. That is one keyword in a family with hundreds of members, and
the growth is algorithm-driven: eBay keeps expanding required specifics, and
every expansion sends more people searching.

**Why it fits.** These readers are FlipDesk's exact user. Someone searching
how to bulk-edit item specifics is someone who needs a bulk-edit tool.

**What kills it.** Same as Path 2. If the marketplace holds its own queries,
the path is closed. This one is probably more open than Path 2 because
procedural how-to queries reward better explanations, where policy queries
reward the official source.

### Path 6: switch sides, target buyers

> [!warning] The 65,650 headline is 76 percent `is poshmark legit`. The real prize here is the three condition-vocabulary terms at 5,000 each, which already have pages.

**The bet.** Everything on the site addresses sellers. Buyers outnumber
sellers by a large multiple and ask questions that grading answers directly:
what EUC means, what NWOT means, how to tell if a listing is honest, how to
read measurements when you cannot try it on, whether a seller is
trustworthy.

**Why it is interesting.** It repurposes the glossary and condition work
already built, aimed at a bigger audience.

**Why it is ranked sixth.** Buyers do not pay for grading. The monetization
runs through the certificate flywheel and the trust surfaces, which is a
longer and less certain path than selling a tool to a seller. Traffic would
go up. Revenue might not.

**What kills it.** Nothing kills it as content. What kills it as a strategy
is that it does not have a business model attached yet. Do not lead with it.

### Path 7: reposition the funnel around FlipDesk

> [!success] Small volume, largest bids in the whole pull (54.90, 50.19, 39.17 dollars). Keep as the revenue leg.

> [!note] Decided 2026-09-01: GradeThread stays the front door, cross-listing is the capture leg, no rename. See "Decision, 2026-09-01" under "Path 7 and the competitor question" below.

**The bet.** This is not a content path, it is a positioning one, and it may
be the real problem underneath all of the above. The site leads with grading.
Grading has no search demand. FlipDesk solves problems that people do search
for, and grading is the reason to pick it over Vendoo or List Perfectly.

**What changes.** Grading stops being the front door and becomes the
differentiator inside the door. Homepage, primary navigation and the highest
tier of the sitemap lead with reseller workflow. The grading pages stay,
still get built, and still do the GEO work, but they stop being what the
funnel is optimized around.

**The supporting evidence.** The original pull found the high-CPC commercial
terms sit entirely in this universe. `clothing inventory management software`
bids 20 to 47 dollars on 110 searches a month. Advertisers do not pay 47
dollars a click for traffic that does not convert.

**What kills it.** Nothing in the data. The objection is strategic: grading
is the moat and leading with the commodity surrenders it. The counter is that
a moat around a market with no traffic is not a moat. This is a judgment
call, and it is yours.

### Path 8: stop optimizing for Google

> [!note] Not measurable in a Keyword Planner pull by construction. Unchanged: additive, not primary.

**The bet.** Accept that the grading universe will never produce Google
volume, and redirect that effort to where the audience actually is:
ChatGPT and Perplexity citations, Reddit, and YouTube.

**Why it is worth naming.** The original plan was right that AI engines have
no incumbent answer for condition questions. That thesis has not been tested
against a real citation-tracking panel yet. The infrastructure for it exists
in [[seo-distribution-and-measurement]] and [[ai-crawler-policy]], and
[[youtube-grading-shorts]] already scopes the video side.

**Why it is ranked last as a primary strategy.** AI-referred traffic is real
but small in absolute terms today, and it is not measurable with the
precision needed to steer a roadmap. As a supporting channel it is sound. As
the answer to "we have no traffic", it is not.

**What kills it.** Nothing kills it. It is additive. It just cannot carry the
number alone.

## Results of the 2026-08-18 pull

All 183 terms came back. Full join in
`docs/seo/keyword-pull-2026-08-results.csv`.

**Read the volumes as buckets, not numbers.** Every value returned as 50, 500,
5,000 or 50,000, which is what Keyword Planner gives an account without active
spend. Real volume sits somewhere inside the bucket (50 means 10 to 100, 50,000
means 10,000 to 100,000). The ordering below is robust anyway: recomputing every
cluster at its bucket FLOOR instead of its midpoint changes no path's rank.

| Path | Midpoint | Floor | Blank | Terms > 50 | Verdict |
|---|---|---|---|---|---|
| 1 damage and care | 295,750 | 59,150 | 8/55 | 42 | **Clears** |
| 3 calculators and tools | 128,700 | 25,740 | 5/23 | 14 | **Clears** |
| 6 buyer side | 65,650 | 13,130 | 10/18 | 5 | Mirage, see below |
| 7 repositioning | 18,200 | 3,640 | 3/16 | 9 | Clears on volume |
| 5 marketplace how-to | 9,900 | 1,980 | 4/22 | 10 | Marginal |
| 2 returns and disputes | 5,950 | 1,190 | 21/32 | 2 | **Dead** |
| 4 resale value | 1,400 | 280 | 7/17 | 2 | **Dead** |

### The returns spine is dead, and it was the recommendation

Path 2 was both the original hypothesis and the note's revenue leg. The data
does not support it. Twenty-one of its 32 terms returned blank, and of the
5,950 midpoint total, 5,000 is `how to block a buyer on ebay`, which is a
blocking query rather than a dispute query. **Strip that one term and the
entire dispute cluster is 950 a month.** Every specific query the cluster was
built on came back blank: `how to fight a not as described claim on ebay`,
`how to appeal an ebay return case`, `how to respond to an ebay return
request`, `ebay buyer lying about item condition`, `poshmark case opened
against seller`, `how to dispute a mercari return`.

The pain is real. People do not take it to Google in these words, or they take
it to the eBay community forums. Do not build the cluster. One page covering
the topic is enough, and the existing `/reselling/reduce-ebay-returns` already
is that page.

### Path 6's number is one keyword

`is poshmark legit` alone is 50,000 of the 65,650, which is 76 percent of the
cluster, and it is a query GradeThread cannot monetize. That is exactly the
concentration trap this note warned about. Ignore the headline number.

### The finding that changes the diagnostic

Three condition-vocabulary terms came back at 5,000 a month each on Low
competition:

| Keyword | Volume | Competition |
|---|---|---|
| `what does euc mean` | 5,000 | Low |
| `what does nwt mean` | 5,000 | Low |
| `what does pre owned mean` | 5,000 | Low |

**Pages for all three already exist** in the reseller glossary. That is roughly
15,000 monthly searches, low competition, on content that shipped months ago.

This is now the sharpest diagnostic available, better than the one at the top
of this note. Look up those three URLs in Search Console. If they are indexed
and taking impressions, the site can rank and the problem was demand, so the
path choice below is the whole fix. If they are not indexed, or indexed with
near-zero impressions on terms this soft, the problem is cause 2 or cause 3 and
**no new content universe will help until that is fixed.** Check this before
building anything.

## The revised recommendation

Path 2 is out. Path 4 is out. The barbell becomes:

- **Lead, Path 1, damage and care.** 295,750 at midpoint, 42 of 55 terms above
  50, and 2.3 times the next path. Start with **repair, not stains**: the
  repair sub-cluster is 122,000 across only 10 terms with 8 of them Low
  competition, where stain removal is 138,150 across 18 terms with 11 at Medium
  or High. Same volume, half the fight. The two entry pages are `how to fix a
  broken zipper` and `how to sew on a button`, both 50,000 and both Low.
- **Lead on order, Path 3, the calculators** (see sequencing below). Promoted out of "ship regardless".
  128,700 total, and `ebay fee calculator` carries a 13.23 dollar top-of-page
  bid at 50,000 searches, which is volume and commercial intent in the same
  keyword. `ebay shipping calculator` is another 50,000. `depop fee calculator`
  is 5,000 and flagged as growing.
- **Revenue, Path 7, the repositioning.** Volume is small and the bids are not:
  `reseller inventory management` tops out at 54.90 dollars, `reseller profit
  tracker` at 50.19, `clothing inventory management software` at 39.17, `multi
  channel listing software` at 34.51. Build these as conversion pages and
  accept three-figure monthly traffic. The three comparison terms
  (`mercari vs ebay`, `poshmark vs mercari`, `depop vs poshmark`) are 5,000
  each and carry the cluster's traffic.
- **Second wave, Path 5.** 9,900 is marginal, but `ebay item specifics`,
  `how to share on poshmark` and `best crosslisting app for resellers` are all
  flagged as growing, and the audience is FlipDesk's exact user.

Path 1's kill condition **was tested on 2026-08-18 (US-9011) and did not fire.**
Five terms, 39 results, recorded in `docs/seo/repair-serp-check.md`.

Exactly **one** major publisher appears anywhere in the set: Fox News, on an AMP
real-estate URL. None of Tide, Persil, Good Housekeeping, Real Simple or Martha
Stewart appears at all. What holds these SERPs is small craft blogs, clothing
and appliance brand blogs, and UGC — Quora, TikTok, YouTube, Instructables, a
Facebook group, a menswear forum.

Six of the 39 slots are visibly weak: a **jewellery company ranking first for a
sweater-snag query**, Speed Queen's **Thailand** page for a US search, two spam
PDFs on a hijacked New Zealand government domain, one more on a hijacked
university domain, and a London waste-authority leaflet.

**But the check found something the story did not ask for, and it changes what
Path 1 is worth rather than whether it is possible.** Not one of the 39 results
is a resale, grading or secondhand-clothing site; the closest are Oxfam and
Levi's. There is no incumbent to displace, and equally, Google does not read
these queries as resale-shaped and the visitor behind them is not a seller.

So the gate clears on authority and the entire risk moves onto the dilution axis
already described under "The risk Path 1 carries" below. Revised sequencing
inside Path 1:

- **US-9015 (containment) moves ahead of US-9013 and US-9014.** Build the
  `/care/` boundary before the volume. It is cheap now and expensive after a
  hundred care pages exist.
- **Enter on `how to fix a snag in a sweater` and `how to unshrink clothes`,**
  not the two 50,000/mo terms. Weakest incumbents, and both are condition
  defects with a resale consequence, which is the only bridge from repair intent
  back to the product.
- **Do not write the button page.** 50,000/mo of the purest non-adjacent intent
  in the set, held by craft blogs that do it better than we would.

## Sequencing: why Path 3 goes first

Path 1 and Path 3 both clear, and they belong in the plan together. They do
not bring the same person, and that decides the order.

| | Path 1 | Path 3 |
|---|---|---|
| Volume | 295,750 | 128,700 |
| Seller intent | 1,550 (0.5%) | 127,100 (99%) |
| Who arrives | someone with a stain on a shirt they intend to keep wearing | someone listing on eBay right now |
| Time to rank | slowest, highest competition | fast, and the tools earn links |
| Revenue per visit | near zero | direct |

Across the whole pull, 68.8 percent of the volume is consumer and 30.9 percent
is seller. Almost all of the consumer share is Path 1, and almost all of the
seller share is Path 3 plus Path 7.

That is not an argument against Path 1. It is an argument about what Path 1 is
FOR. It is the authority and link engine that makes the seller pages rankable,
and it is nearly free because the flaw data already exists. It is not a
customer acquisition channel, and planning it as one would be a mistake.

**Run it 3, then 7, then 1.**

1. **Path 3 first.** 127,100 of seller-intent volume, every visitor a potential
   customer, and calculators earn the links that currently cap everything else.
   `ebay fee calculator` at 50,000 with a 13.23 dollar bid is the single best
   keyword in the pull on traffic and intent together.
2. **Path 7 alongside, not later.** It is about six landing pages and it carries
   the largest bids in the file (54.90, 50.19, 39.17 dollars). Path 3 feeds it
   directly: a fee calculator ends at "stop doing this in a spreadsheet", which
   is the FlipDesk pitch delivered to someone who just did the math by hand.
   Path 3 and Path 7 form one funnel with no gap in it.
3. **Path 1 third, contained.** Build it under its own directory
   (`/care/…`) rather than mixed into the reseller spine.

### The risk Path 1 carries

**Confirmed by the US-9011 SERP check, not just reasoned about.** Every one of
the 39 results in that check is a craft blog, a brand blog, a UGC thread or a
charity shop. That is the neighbourhood Google would file this content in, and
it is the neighbourhood the entity would drift toward.


At 295,750 a month against a seller surface of roughly 157,000, care content
would become the majority of the site. Google's understanding of the entity
follows the content, and a domain that reads as a laundry-advice site is a
weaker match for `clothing inventory management software` than one that reads
as reseller tooling. Topical dilution is a real cost, not a hypothetical one.

Keep it contained: care content in its own directory, linking down into the
reseller spine but not the reverse, and do not let it onto the homepage or the
primary navigation. Do not use a subdomain, which would split the authority
Path 1 exists to build in the first place.

### The containment, as built (US-9015, 2026-08-18)

The risk above stopped being a warning and became four mechanisms. Guarded by
`src/test/care-containment.test.ts`.

**A subdirectory, never a subdomain.** `/care`, on the main domain. A subdomain
would split the authority this cluster exists to build, which is the only thing
it is for.

**Links run one way.** `/care` is its own hub in `interlink-rules.ts` and
`isCrossHubLinkAllowed` refuses every link INTO it, including from the otherwise
unconstrained non-hub pages like the homepage. Care pages may link out freely.
`HUB_PILLARS` is typed `Record<Exclude<Hub, "care">, string>`, so giving care a
pillar that cross-hub links could reach is a compile error rather than a quiet
hole.

**Its own sitemap segment.** `sitemap-care.xml`, listed after the two commercial
segments rather than folded into `sitemap-marketing.xml`. A segment is a
statement about what a group of pages is, and 32 laundry-repair pages are not
the same kind of thing as the pricing page. It also makes the cluster's
indexation and impressions readable as one line in GSC, which is what US-9016's
kill criteria need to be answerable at all.

**A ceiling of 40%, reported rather than hoped for.** `careRatio()` in
`functions/_shared/sitemap.ts` returns care URLs as a share of all static URLs.

*Why 40% and not 25% or 60%.* The cluster is 33 of about 226 static routes
today, which is 15%. The full Path 1 build would roughly double that. The
number that matters is not the page count but which way a reader of the sitemap
would describe the site, and past a plurality the honest description changes.
40% is the last point at which the commercial and grading segments together are
still clearly the majority, and it leaves room for the flaw-crossed-with-fabric
matrix (US-9014) to land without a rewrite of the boundary. It is a decision,
not a measurement, and it is written down so the next person argues with the
reasoning instead of the number.

### Path 1 is an authority engine, not an acquisition channel

Worth stating flatly, because the volume invites the opposite conclusion and the
opposite conclusion is the failure mode every guard above exists to prevent.

Path 1 is 295,750/mo. **1,550 of that carries seller intent. That is 0.5%.**

So it is not a customer channel and must never be planned as one. What it is
worth is links, topical breadth around garment condition, and a reason for
somebody outside the resale world to cite the domain at all. Those are real and
slow. Judged as acquisition it will look like a failure at every review, and
somebody will correctly kill it for missing a target it was never built to hit.

### The differentiator that keeps Path 3 from being a commodity

Fee calculators are commoditized and rank largely on domain strength, which is
the thing GradeThread does not have yet. The way in is the axis nobody else
has: a calculator that takes **condition** as an input and estimates the sale
price from it, not just the fee on a price the user types in. That is the
grading engine doing work inside a tool people already search for.

## Path 7 and the competitor question

The concern is that Vendoo, List Perfectly and Crosslist already own this
space. That is true, and it applies to 12 percent of the path.

Path 7 splits in two, and only one half has those competitors in it:

| Segment | Volume | Share | Who ranks |
|---|---|---|---|
| Comparisons | 16,000 | 88% | blogs and listicles |
| SaaS head terms | 2,200 | 12% | Vendoo, List Perfectly, Crosslist |

And 15,000 of that 16,000 is **marketplace versus marketplace**, not tool
versus tool: `mercari vs ebay`, `poshmark vs mercari`, `depop vs poshmark` at
5,000 each. Vendoo does not rank for `mercari vs ebay`. Nobody selling
crosslisting software does. Those SERPs belong to reseller blogs and content
sites, which is a much softer field than a funded SaaS competitor.

`mercari vs ebay` carries an advertiser competition index of **1 out of 100**
on 5,000 searches a month. That is the anomaly the July research already
flagged as the best pure-SEO target in the file, and it has not changed.

### What is already built, and what is missing

- `/compare/mercari-vs-ebay` **exists**. The 5,000-a-month, index-1 term has a
  live page.
- `poshmark vs mercari` and `depop vs poshmark` have **no page**. That is
  10,000 a month of the strongest segment in the path, unserved.
- All three competitor-alternative pages (Vendoo, List Perfectly, Crosslist)
  **exist**. Do not invest further here: `vendoo alternative` is 500 a month
  and `list perfectly alternative` came back blank. The alternative play is
  real but small, and it is already done.

### The reframe that matters more than the ranking

The SaaS head terms are not a traffic play and should not be judged as one.
`clothing inventory management software` at 500 a month will never move the
number, whoever ranks for it. Those pages exist to **convert traffic that
arrives from Path 3**, where someone finishes a fee calculation and needs
somewhere to land. Judge them on conversion, not position. Competing with
Vendoo for a 500-a-month keyword is not the job; being the page that catches
127,100 a month of calculator traffic is.

Where the head terms do pay is bid economics. Ranking organically for
`reseller inventory management` (54.90 dollars top-of-page) or `clothing
inventory management software` (39.17 dollars) is worth that much per click in
avoided spend, on volume too small for anyone to fight hard over. Build them
once, well, and stop.

### Decision, 2026-09-01: GradeThread is the front door, cross-listing is the capture leg

Path 7 as written asked whether the homepage, nav and sitemap should lead with
FlipDesk. Decided by Dj on 2026-09-01: **no rename. GradeThread stays the
identity and the front door; the reseller workflow, cross-listing in
particular, is the leg that captures search; grading is the differentiator
inside the product and never the search front door.** The hero already reads
this way ("Photograph it. We'll write the listing." under the GradeThread
name), so what changes is what the site captures, not what it is called.

Three readings from the 2026-09-01 Search Console export in `keyword/`
(`Queries.csv`, 366 queries, 1,859 impressions, 8 clicks) shape the
"rely heavily on cross-listing" half, and they narrow it:

- **The cross-listing head terms are not the higher-searched leg.**
  `cross listing software`, `cross listing app`, `best cross listing app` and
  38 phrasings like them: 161 impressions, zero clicks, positions 42 to 64,
  all landing on the listicle. `docs/seo/crosslisting-cluster-diagnosis.md`
  explains why a vendor's own "best apps" page cannot rank there. Do not
  chase them.
- **The cross-listing task queries are.** 27 marketplace-pair queries
  (`mercari to grailed`, `grailed to poshmark`, `whatnot to poshmark`,
  `import mercari to grailed`): 225 impressions, zero clicks, positions 11 to
  24, and every one lands on a blog post rather than a page that does the
  thing. That is the family to build (US-9214 in `prd-crosslisting.json`):
  one honest page per pair, mechanism stated from `MARKETPLACE_TIER`, the
  extension install and `/flipdesk/crosslisting` as the answer. The
  marketplace-versus-marketplace comparisons (15,000 a month, 88 percent of
  this path, above) stay the volume leg beside it.
- **Grading vocabulary confirms the split a fourth time.** 44 grading and
  condition queries earned 486 impressions and one click in this export, and
  the 2026-08-31 tool-noun pull (`docs/seo/keyword-pull-toolnouns-2026-08-31.md`)
  returned zero for all five condition-tool terms. Grading sells as the thing
  Vendoo cannot do, on every product page; it does not bring the visitor.

What this changes in the build: the SaaS head-term pages keep the conversion
job described above; the pair family and the extension install funnel
(US-9210) become the reseller capture leg; the listicle is reframed or retired
per the diagnosis. Nothing in the sequencing moves: Path 3 still goes first
and Path 1 stays the authority engine.

### Another already-built page for the Search Console test

`/compare/mercari-vs-ebay` joins the three glossary terms as a live page
targeting real, low-competition demand. That is now roughly **20,000 monthly
searches already served by shipped pages**. If none of those four URLs takes
impressions, demand was never the problem and the answer is cause 2 or cause
3. Check all four together.

## The backlog

Sixteen stories in **`prd-seo.json`**, US-9001 to US-9016, held entirely out
of `prd.json` so the Ralph loop cannot collide with them.

Ordered 3 then 7 then 1, behind two gates:

| Priority | Stories | What |
|---|---|---|
| 1 | US-9001 | Search Console diagnostic. Blocks everything else. |
| 2-7 | US-9002 to US-9007 | Path 3, the calculators |
| 8-10 | US-9008 to US-9010 | Path 7, comparisons and conversion |
| 11 | US-9011 | SERP gate on Path 1's untested kill condition |
| 12-15 | US-9012 to US-9015 | Path 1, damage and care, contained |
| 16 | US-9016 | Kill criteria and cluster tracking |

Path 2 and Path 4 have no stories. The pull killed them and adding stories
"just in case" is how a dead path comes back.

### Why the ids start at 9001

The first attempt reserved US-2674 to US-2689 the documented way, by taking
the block from `prd.json.nextId` and bumping it. That failed twice over: PR
#275 merged the same block to `main` first as the eBay ranking stories, so the
ids collided anyway, and the bump itself was the only thing putting `prd.json`
into the merge conflict.

Sequential reservation does not work when another loop is allocating from the
same counter concurrently. A high reserved block does. Ralph allocates upward
from US-2684 and will not reach 9001, so `prd.json` never has to be touched by
this file again. Priorities are local to `prd-seo.json`; merging back means
renumbering into the live sequence and re-ranking.

## The keyword pull, and what it taught

`docs/seo/keyword-pull-2026-08.csv` holds the 183 terms, tagged by path;
`docs/seo/keyword-pull-2026-08-results.csv` holds the returned figures joined
back to those tags.

Reading rules, three of which the pull confirmed the hard way:

- **Blank does not mean zero, but 21 blanks out of 32 means something.** A
  scattered blank is suppression. A cluster where two thirds of the specific
  queries return nothing is a cluster people do not phrase that way. That is
  what killed Path 2.
- **Volume without a SERP check is a trap.** The last plan had `graded
  clothing` at 70 a month, which turned out to be wholesale bale grading and
  the wrong audience entirely. For any term above 500 a month, look at who
  actually ranks before counting it.
- **Competition in Keyword Planner is advertiser competition, not organic
  difficulty.** Low competition on a term eBay's own help page owns is still
  unwinnable.
- **The number that decides a path is the cluster total, not the head term.**
  A path with one 2,000-a-month term and nothing else is worse than a path
  with sixty 100-a-month terms.

One threshold turned out to be mis-specified, and it is worth recording rather
than quietly dropping. The "30 terms above 50 a month" test measures how many
terms were submitted as much as how deep the market is: Path 3 cleared the
volume bar six times over on 23 submitted terms and could never have hit 30. A
depth test should be a ratio, not a count. Path 3 had 14 of 23 above 50, which
is 61 percent, and that is the number that should have been in the rule.

Pass thresholds, as set in advance:

- A path clears if its cluster totals more than 10,000 monthly searches with
  at least 30 individual terms above 50 a month.
- A path is marginal between 3,000 and 10,000, and should only run if it is
  cheap, which currently means Path 1.
- A path is dead below 3,000, whatever it does for positioning.

## Related

- [[seo-geo-strategy]] — the July 2026 plan this note revisits
- [[seo-distribution-and-measurement]] — kill criteria and the GSC cluster views
- [[authority-machine-activation]] — the off-page work cause 3 would demand
- [[seo-public-route-registry]] — how new page families get registered
- [[content-publishing]] — the publishing pipeline any of these paths would use
- [[INDEX]]
