---
title: SEO strategy options (Aug 2026 reset)
type: decision
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-18
revisit_by: 2026-11-18
tags: [seo, geo, strategy, growth, options]
summary: Eight candidate paths for a new SEO strategy after the grading-first plan failed to produce traction, with the diagnostic that has to run first and the keyword pull that settles which paths are real.
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

## The eight paths

Ranked by expected traffic per unit of build effort, given what already
exists. Each names what would kill it, because a path without a kill
condition is a hope.

### Path 1: the damage and care universe

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

## The recommendation

Run the diagnostic first. It is half an hour and it can invalidate most of
this note.

If the diagnostic returns cause 1, no demand, run a barbell:

- **Volume leg: Path 1**, the damage and care universe. Biggest addressable
  pool, cheapest to build because the data already exists, and topically
  defensible because grading damage is the product.
- **Revenue leg: Path 2**, the returns and dispute spine. Lower traffic,
  highest intent, and the cleanest line from a searched problem to the
  product.
- **Always: Path 3**, the calculators. Ship them regardless. They are cheap
  and they fix the link problem that will otherwise cap every other path.
- **Underneath everything: Path 7**, the repositioning. If FlipDesk is what
  people search for, FlipDesk should be what the funnel leads with.

Hold Path 4 until the cause-2 answer is in, because value pages are the most
likely family to be judged thin. Treat Paths 5, 6 and 8 as second-wave.

If the diagnostic returns cause 2 or cause 3, none of the content paths are
the answer yet. Fix indexation or authority first, then come back to this
list.

## The keyword pull

`docs/seo/keyword-pull-2026-08.csv` holds the terms to run through Keyword
Planner, tagged by path. One pull settles which paths are real.

Reading rules, learned from the last pull:

- **Blank does not mean zero.** Keyword Planner suppresses low-volume terms.
  Cross-check against Search Console impressions and autocomplete.
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

Pass thresholds, set in advance so the result is not rationalized after the
fact:

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
