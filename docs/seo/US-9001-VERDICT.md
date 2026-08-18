# US-9001 verdict — Search Console diagnostic

Source: `keyword/` export, Web search, last 6 months (2026-05-25 to 2026-08-16).
Analysed 2026-08-18. 366 queries, 270 pages.

## The answer

**None of the three causes. The premise the SEO backlog was built on is wrong.**

The backlog assumes GradeThread has near-zero search traffic and needs a new
content universe. The export says GradeThread ranks fine, is indexed fine, and
**does not get clicked**. That is a fourth cause nobody listed, and it is much
cheaper to fix than any of the sixteen build stories.

## The three causes, tested

| Cause | Test | Result |
|---|---|---|
| 1. No demand | Are pages ranking with no impressions? | **No.** 6,434 impressions in 6 months and accelerating. |
| 2. No indexation | Are pages missing from the index? | **No.** 270 URLs earn impressions. Sitemap is 519 URLs, complete, correctly served. |
| 3. No authority | Are pages buried below 20? | **Mostly no.** 156 of 270 URLs rank in the top 10. |

## What is actually happening

### 1. The site is three months into a normal ramp, not flat

| Week | Impressions | Clicks |
|---|---|---|
| Jun 1-7 | 2 | 0 |
| Jun 29 - Jul 5 | 15 | 0 |
| Jul 20-26 | 1,087 | 6 |
| Aug 3-9 | 1,618 | 16 |
| Aug 10-16 | **2,410** | **27** |

First impression was 2026-06-06. Impressions are up 1,200x in ten weeks and
still climbing. Nothing is broken. It is early.

### 2. The real problem: ranking without clicks

| Position band | URLs | Impressions | Clicks | CTR |
|---|---|---|---|---|
| 3-10 | 149 | 3,545 | 30 | **0.85%** |
| 10-20 | 82 | 1,766 | 22 | 1.25% |
| 20-50 | 27 | 1,331 | 3 | 0.23% |

A page sitting at position 3-10 normally earns 3% to 10%. GradeThread earns
0.85%. There are 149 URLs already on page one being passed over.

Sharpest example: the query `vguc meaning` gives GradeThread **355 impressions
at average position 8.88 and zero clicks.** Not one.

### 3. Definition pages are a zero-click keyword class

`/grading/glossary/vguc` is the best-ranking glossary page: 503 impressions,
position 8.8, **1 click** (0.2%). Google answers "what does VGUC mean" inside
the results page. The searcher never needs to leave.

Nineteen glossary pages earn impressions. Between them: **2 clicks.**

This matters because US-9001's own premise named three glossary URLs as proof of
low-competition demand. Here is what they actually did:

| URL | Impressions | Clicks | Position |
|---|---|---|---|
| /grading/glossary/euc | 0 | 0 | not ranking |
| /grading/glossary/nwt-vs-nwot | 0 | 0 | not ranking |
| /grading/glossary/pre-owned | 0 | 0 | not ranking |
| /compare/mercari-vs-ebay | 2 | 0 | 39 |

Three of the four "proven demand" pages have never had a single impression.

### 4. Tool pages already beat everything else by 10x

| Page | Impressions | Clicks | CTR | Position |
|---|---|---|---|---|
| **/tools/authenticity-check** | 178 | **16** | **9.0%** | 13.4 |
| /tools/fit-checker | 3 | 1 | 33% | 6 |
| Site average | - | - | 0.85% | 11.6 |

One tool page at position 13 out-clicks 104 blog posts sitting at position 8.
That is the strongest evidence in the whole export, and it points straight at
Path 3. **Build the calculators.**

### 5. Blog volume does not convert

`/blog` is 104 URLs and 3,604 impressions (56% of all impressions) for 21
clicks. The top blog post, `/blog/best-resale-apps-designer-luxury-clothing`,
has 1,136 impressions at position 21 and 3 clicks.

## Corrections to the backlog

**US-9008 is wrong and needs rewriting.** It says the comparison family "currently
holds only mercari-vs-ebay" and asks to build `poshmark-vs-mercari` and
`depop-vs-poshmark`. Both pages have been live since 2026-07-06:

- `/compare/poshmark-vs-mercari` — HTTP 200, 1,430 words, 10 impressions, position 44.8
- `/compare/depop-vs-poshmark` — HTTP 200, 1,393 words, 0 impressions

There are 16 live `/compare/` URLs, not one. The `COMPARISONS` array in
`comparison-guides.ts` has a single entry because the other 15 come through
`public-routes.ts`. The grep that produced the story's claim only looked at the
array. The story should become "fix the two that rank at 44 and nowhere," not
"create two new pages."

The `/compare/` family is otherwise the second-best section on the site: 1,172
impressions, 8 clicks, average position 8.5 on the leaders.

## Recommendation

Do not start with US-9002. Start with the thing the data actually asks for.

1. **Fix titles and meta descriptions on the 19 URLs in
   `docs/seo/ctr-rewrite-worklist.csv`.** They rank on page one and get skipped.
   Cheapest work in the backlog: a copy pass over pages that already exist.
   Be clear on the size of the prize, though. Closing the whole gap is worth
   about **66 clicks over six months**, against the 55 the site earned. It
   roughly doubles a small number. Do it because it costs a day, not because it
   changes the trajectory.
2. **US-9002 through US-9007, the calculators. This is the real bet.** `/tools/authenticity-check`
   proves the format converts on this site at 9%. This is the right bet and the
   evidence is local, not borrowed from the Keyword Planner.
3. **Deprioritise anything glossary-shaped.** Definition queries are answered in
   the SERP. Twenty pages, 1,087 impressions, 4 clicks.
4. **Rewrite US-9008** to target the existing pages.
5. **Treat the Keyword Planner volumes with suspicion.** Three of the four URLs
   picked as "proven 5,000/mo demand" have zero impressions after ten weeks. The
   50,000/mo figure behind `ebay fee calculator` in US-9003 comes from the same
   bucketed pull. Build the calculator because the format converts here, not
   because of that number.

## What is NOT blocked

Causes 2 and 3 both failed their tests, so no BLOCKED note goes on the build
stories. US-9011's SERP-check gate still stands on its own merits.

## Verified technical state (2026-08-18)

- All four target URLs: HTTP 200, self-canonical, `index, follow`, in sitemap.
- `/sitemap.xml`: flat urlset, 519 URLs, exactly equal to the union of all 15
  segment sitemaps. No orphans.
- `robots.txt` advertises `sitemap.xml` and `sitemap-images.xml` only. The other
  13 segments work but are not submitted, so per-cluster index coverage is not
  visible in Search Console. Submitting them is free and US-9016 needs it.
- Mobile average position 8.41, desktop 21.94. Worth a look, out of scope here.
- 76% of impressions are United States.
