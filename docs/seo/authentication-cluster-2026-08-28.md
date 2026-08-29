# The authentication cluster, measured 2026-08-28

Pulled ahead of the other four gaps (US-9027) because the case looked strongest:
`/tools/authenticity-check` is the best-converting page on the site at **10.98%
CTR**, its generic head term `brand authenticity checker` was one of only three
clean SERPs in the US-9026 audit, and both keyword pulls between them had sized
this cluster at **one keyword, 50/mo**.

Data: `docs/seo/keyword-pull-2026-08-28-authentication.csv`, 945 rows.

## How it was pulled, and what that costs

Google Ads Keyword Planner was **not** used. The integration exists
(`services/edge-functions/src/lib/keyword-research.ts`) but running it needs
production Ads credentials and spends against the account, which is the owner's
call rather than mine.

Instead: 109 autocomplete probes across 20 brands and 5 templates, deduplicated
to 945 distinct authentication queries. Autocomplete returns what people
actually type, ordered by Google's own popularity signal.

**The honest limitation: this gives no volume figures.** The `avg_monthly`
column in the CSV is empty and should stay empty rather than be guessed at. What
it gives instead is the query *space* and the *shape* distribution, and this
repo's own record argues that is the more reliable half: US-9001 found three of
four "proven 5,000/mo" URLs earning zero impressions after ten weeks, and the
Planner numbers here are bucketed estimates from an account with no spend.

## The cluster is real, uniform, and bigger than one keyword

945 queries. Every one of the 20 brands produces the same five shapes:

| shape | n | example |
|---|---|---|
| real vs fake | 253 | `north face real vs fake` |
| how to spot a fake | 205 | `how to spot fake carhartt jacket` |
| how to tell if X is fake | 172 | `how to tell if a patagonia is fake` |
| **tool noun** | **101** | `moncler authenticity check` |
| fake {brand} {part} | 43 | `fake carhartt tag` |
| other | 171 | |

Brands are evenly represented, 37 to 49 queries each: Lululemon, Carhartt,
Jordan, Patagonia, Ralph Lauren, Burberry, Michael Kors, UGG, Stone Island,
North Face, Adidas, Nike, Moncler, Arc'teryx, Louis Vuitton, Gucci, Supreme,
Coach, Canada Goose, Levi's.

That uniformity is what makes it look like an obvious programmatic play:
20 brands times one tool page.

## The check that killed the obvious play

The US-9026 finding was that named tool nouns are the one query shape without an
AI Overview. The hypothesis was that `{brand} authenticity check` would inherit
that. **It does not.**

| query | AI Overview | organic |
|---|---|---|
| `north face authenticity check` | yes | 8 |
| `carhartt authenticity check` | yes | 8 |
| `lululemon authenticity check` | yes | 8 |
| `stone island authenticity check` | yes | 7 |
| `patagonia authenticity check` | yes | 7 |
| `legit check app` | yes | 8 |
| `north face real vs fake` | yes | 6 |
| `moncler authenticity check` | **no** | 8 |
| **`clothing authentication service`** | **no** | 9 |
| **`brand authenticity checker`** (US-9026) | **no** | 9 |

**Six of seven brand-specific tool nouns carry an AI Overview.** Attaching a
brand to the tool noun loses the exemption, because a brand-plus-question is
exactly what an AI Overview is good at answering.

So the twenty-page build is the wrong build, and this cost about forty minutes
to find out rather than a sprint.

## Where the clean SERPs actually are

The two clean results are both **commercial service** queries, and their top
results say why:

- `clothing authentication service`: realauthentication.com, legitapp.com,
  legitgrails.com
- `brand authenticity checker`: already where GradeThread ranks at position
  12.7, on the page that converts at 10.98%

That is a market with buyers in it, and Google is still returning links for it.

## Who holds the space, and are they reachable

Not publishers. Across the brand SERPs the recurring names are LegitApp,
LegitGrails, RealAuthentication and TrussArchive (which appeared for both
Patagonia and Stone Island), plus each brand's own help page and Reddit.

LegitApp runs exactly the per-brand page play, at
`legitapp.com/what-we-authenticate/{brand}`. So the pattern is proven
commercially. It is just not currently a clickable SERP for most brands.

## Recommendation

1. **Do not build 20 brand pages.** Six of seven of their head terms are
   AI-Overview'd. It would be the /grading mistake with a different vocabulary:
   pages that rank and are not clicked.

2. **Own the commercial head terms, where the SERP is clean.**
   `clothing authentication service` and `brand authenticity checker` both
   return links, both have commercial competitors rather than publishers, and
   GradeThread already ranks for the second on its best page. That is one page
   strengthened, not twenty built.

3. **Use the 945 brand queries as depth on the existing tool, not as URLs.**
   The per-brand tells (a Carhartt tag, a Stone Island badge, a Moncler code)
   are real content and they belong inside `/tools/authenticity-check` where the
   converting page already is, feeding the checker's own brand knowledge.

4. **Recheck Moncler.** It is the one brand whose tool noun came back clean. One
   sample is not a finding, but if a second check holds, it is worth knowing
   whether it is the brand, the query volume, or the timing.

5. **Fix the root cause.** `DEFAULT_SEED_KEYWORDS` in
   `keyword-research.ts` carries seven seeds and not one is authentication-shaped.
   That is why two pulls sized this cluster at a single keyword. The seed list is
   the blind spot, not the tool.

## Caveats

One sample per query, signed-in desktop browser, US, on 2026-08-28. AI Overview
presence varies by user, location and over time. The brand list is the twenty
most obvious resale brands and is not exhaustive. No volume figures at all, by
construction.
