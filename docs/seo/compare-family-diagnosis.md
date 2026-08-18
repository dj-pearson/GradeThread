# US-9008 — why two comparison pages don't rank

Source: the same Search Console export as `US-9001-VERDICT.md`
(`keyword/`, 2026-05-25 to 2026-08-16). Analysed 2026-08-18.

## The answer

The pages are not the variable. **Which platforms they name is.**

`/compare/poshmark-vs-mercari` and `/compare/depop-vs-poshmark` were singled
out for repair on the assumption that something is wrong with them. Nothing is.
All 16 comparison pages ship from one template, published the same day, with the
same structure, the same word count band and the same schema. They split cleanly
in two, and the line is not page quality.

## The natural experiment

| Page | Impressions | Position |
|---|---|---|
| /compare/vinted-vs-mercari | 530 | **8.5** |
| /compare/grailed-vs-ebay | 165 | **9.7** |
| /compare/grailed-vs-poshmark | 124 | **11.0** |
| /compare/whatnot-vs-poshmark | 99 | **15.5** |
| /compare/mercari-vs-grailed | 81 | 13.3 |
| /compare/grailed-vs-depop | 4 | 8.5 |
| … | | |
| /compare/vinted-vs-poshmark | 37 | 21.2 |
| /compare/mercari-vs-depop | 28 | 23.5 |
| /compare/ebay-vs-poshmark | 10 | 40.9 |
| /compare/poshmark-vs-mercari | 10 | **44.8** |
| /compare/mercari-vs-ebay | 2 | **39.0** |
| /compare/depop-vs-poshmark | **0** | never ranked |

Every pair naming Grailed or Vinted ranks in the top 15. Every pair made only of
eBay, Poshmark, Mercari and Depop ranks at 20 to 45. The query data says the
same thing from the other side: `grailed vs ebay` sits at 5.25, `poshmark vs
grailed` at 6.5, `grailed vs poshmark` at 7.37, `vinted vs mercari` at 9.04 —
while `mercari vs ebay` sits at 31, `ebay vs mercari` at 34 and `depop vs
poshmark` at 29.

Grailed and Vinted are the pairs nobody has written twenty listicles about. The
four incumbents are the pairs everybody has.

## Two things that rule out the obvious alternatives

**More words did not help.** `/compare/mercari-vs-ebay` is the hand-written
flagship: a bespoke table, its own intro and verdict, the most editorial
investment in the family. It ranks 39th on 2 impressions, worse than 13 pages
built from the template.

**More internal links did not help either.** Until today, exactly two comparison
pages carried named anchor sets in `interlink-rules.ts`:
`poshmark-vs-mercari` and `mercari-vs-ebay`. Those are the same two pages at
positions 44.8 and 39. The pages at 8.5 and 11.0 had none. The confound runs
backwards from the "fix the page" hypothesis, which is about as clean as this
kind of evidence gets.

## What changed as a result

The interlink anchor budget moved to `/compare/vinted-vs-mercari` (position 8.5)
and `/compare/grailed-vs-poshmark` (position 11.0). Internal authority is worth
spending where it can push a page across a threshold. Positions 8 to 11 are one
good push from the top five, which is where clicks actually live; position 44.8
is not a threshold problem.

Titles and descriptions for four pages were rewritten under US-9017, including
both pages named in this story's sibling set.

## The open decision: depop-vs-poshmark

Two GradeThread URLs target this query and neither wins it.

| URL | Impressions | Clicks | Position |
|---|---|---|---|
| /blog/depop-vs-poshmark-which-should-you-use | 168 | 1 | 16.45 |
| /compare/depop-vs-poshmark | **0** | 0 | never ranked |

Google picked the blog post, and the head queries confirm it is a weak pick:
`poshmark vs depop` at 22.6, `depop vs poshmark` at 29.17. This is not a strong
page being held back by a duplicate; it is two weak signals for a term the site
cannot currently win.

The consolidation is still correct on the merits — one URL per intent — and the
choice of direction is not close, because one side has ten weeks of ranking
history and the other has never had an impression. Recommendation: canonicalise
`/compare/depop-vs-poshmark` to the blog post, keep the page live and reachable
from the hub, and do not expect it to move the number. Migration demand for the
pair is 2 impressions (`depop to poshmark`, position 16.5), so nothing unique
is lost from the index.

**Not done, because de-indexing a page is the operator's call.** Say the word
and it is a one-line change.

## What this means for the rest of the backlog

Do not build more head-term comparison pages. The family already covers all 16
pairs and the ceiling on the incumbent pairs is set by competition the site
cannot outspend at ten weeks old. The pages that rank are the ones nobody
bothered to write, and that is the reusable lesson: pick the pair, not the page.
