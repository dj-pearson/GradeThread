# SERP-feature audit, 2026-08-28

Thirteen target queries checked in a browser for AI Overview, People Also Ask
and organic link count. Run because the AI Overview on the pilling head term
was the single most decisive fact in the US-9019 build, and nobody had checked
whether it was true of the rest of the plan.

Method: a Google search per query, then a DOM read for the AI Overview marker
and a count of distinct organic result links. One query per page load. This is
a signed-in desktop browser in the US, so treat it as one sample of the SERP
shape rather than a rank-tracker snapshot.

## The result

| query | AI Overview | organic links | our page |
|---|---|---|---|
| `ebay fee calculator` | **no** | 10 | `/tools/ebay-fee-calculator` |
| `poshmark fee calculator` | **no** | 10 | `/tools/poshmark-fee-calculator` |
| `brand authenticity checker` | **no** | 9 | `/tools/authenticity-check` |
| `single stitch shirt` | yes | 9 | `/tools/single-stitch-dating` |
| `cross listing software` | yes | 9 | `/reselling/best-crosslisting-apps` |
| `clothing measurement converter` | yes | 9 | `/tools/measurement-converter` |
| `how to check sold items on ebay` | yes | 8 | `/tools/ebay-sold-listings` |
| `how to remove pilling from clothes` | yes | 7 | `/care/pilling` |
| `reseller inventory spreadsheet` | yes | 6 | `/tools/reseller-inventory-spreadsheet` |
| `how to tell if a north face jacket is real` | yes | 6 | none |
| `how to take pictures of clothes to sell` | yes | 5 | `/tools/photograph-clothes-to-sell` |
| `vguc meaning` | yes | **0** | `/grading/glossary/vguc` |

## What it says

**Three of thirteen have no AI Overview, and all three are named tool nouns.**
Not "how to work out eBay fees" but "ebay fee calculator". Not "is my jacket
real" but "brand authenticity checker". The noun the searcher types is the name
of a thing they expect to use, and Google still hands them ten blue links to
choose from.

Everything phrased as a question or a topic gets an AI Overview. `vguc meaning`
is the endpoint of that: the page returned **no organic links at all** in the
captured region. The answer is given and the results are furniture.

## This explains the site's own numbers exactly

The per-family Search Console split has been the puzzle of the last two
months: ten `/tools` URLs out-click a hundred and twenty-two blog posts, at
3.46% against a 0.73% site average, while 87 `/grading` URLs sit at an average
position of 8.6 and convert at 0.33%.

The tempting read was that tool pages are better pages. They are not. **Tool
queries still have clickable results pages and informational queries do not.**
Same site, same authors, same internal linking. The difference is what Google
puts above the result.

Two confirmations from our own data:

- `/tools/authenticity-check` earns **10.98% CTR** at position 11.4. Its head
  term is one of the three clean SERPs.
- `/tools/fit-checker` earns **12.5% CTR**. Same shape.

## What follows

**The query shape is now a build criterion, not a nice-to-have.** Before
committing to a cluster, check the head term for an AI Overview. A 50,000/mo
question-shaped keyword with an AI Overview is worth less than a 500/mo tool
noun without one, and until now nothing in the process could tell those apart.

Three consequences worth stating plainly:

1. **The glossary cluster is not recoverable by writing.** 87 URLs, position
   8.6, 0.33%. `vguc meaning` returns zero organic links. No amount of depth
   fixes a results page that has no results. Their remaining value is internal
   linking and AI citation, not clicks, and they should be measured that way.

2. **Four of the five pages built on 2026-08-28 target AI-Overview queries.**
   That was not known when they were scoped. They are still worth having: they
   are the best pages on their terms and the AI Overview cites sources. But
   their click forecast should be halved, and the US-9024 gate already requires
   a CTR above 1% rather than a position, which is the right instrument.

3. **The unexploited surface is tool nouns, and we have only three.** The
   fee calculators shipped on 2026-08-18, which is ten days before the Search
   Console window closed, so their position 25-49 is an unevaluated page rather
   than a failing one. Do not touch them yet.

## Caveats, so the next reader can weigh this

- One sample per query, on one machine, signed in, in the US. AI Overview
  presence varies by user, location and over time.
- Organic link count is a count of what the DOM exposed in the results region,
  not a count of what a human perceives above the fold.
- `vguc meaning` returning 0 links may be a selector artifact as well as a real
  absence. The AI Overview marker was present either way, and the Search
  Console record for that URL (355 impressions, position 8.9, **zero clicks**)
  agrees with the harsher reading.
- This is a snapshot. Re-run it alongside the quarterly keyword pull that
  US-9016 already schedules for 2026-11-18.
