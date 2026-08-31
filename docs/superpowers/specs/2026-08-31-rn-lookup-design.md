# RN number lookup: design

**Date:** 2026-08-31
**Status:** approved in chat, not yet planned
**Backlog:** `prd-seo.json`, stories not yet filed

## Why this exists

`rn number lookup` and `rn number search` returned 5,000 monthly searches each
in the 2026-08-31 tool-noun pull, Low competition, with a top-of-page bid of
zero. Ten thousand searches a month that no advertiser wants and no SaaS is
defending. Full pull in `docs/seo/keyword-pull-toolnouns-2026-08-31.md`.

It is also the rare keyword where the SERP is still clickable. The 2026-08-28
audit (`docs/seo/serp-feature-audit-2026-08-28.md`) found that named tool nouns
keep their ten blue links while question-shaped queries get an AI Overview. A
lookup is a tool noun.

The goal is not the traffic. **A person holding a garment with an unfamiliar tag
is one step away from being a customer**, and the tool has to be good enough
that they stay. Anything that reads as a traffic trap fails this design.

## What already exists, and must be reused

Nothing here is greenfield. The pieces were built for other reasons and this
surface joins them up.

| Piece | Where | What it gives us |
|---|---|---|
| `registered_number_registry` | migration `00502` | registry_key, kind, digits, company_name, brand_keys[], source_url, verified |
| `registered_number_sightings` | migration `00501` RPC | one row per number seen on a real tag, with counts |
| `registered-numbers.ts` | edge lib | parsing, range expansion, the RN-to-brand cross-check, the outcome vocabulary |
| `functions/style/[code].ts` + `_shared/style-code-render.ts` | Pages Functions | the exact page shape: edge SSR, provenance, indexable-only-when-resolved |
| `public-style-code.ts` | edge lib | pure shaping, `indexable` computed once so page and sitemap cannot disagree |
| `public-grading.ts` grade-checker | edge route | anonymous AI vision with per-IP sliding window, global budget ceiling, `rate_limited` code |
| `brand_knowledge` | ~180 rows | the brands worth seeding, and the `brand_keys` an RN resolves to |

## Where the data comes from

**The FTC public search, with no account.** Verified in a browser on
2026-08-31:

- `https://www.ftc.gov/rn-database/search?search=Vuori` returns
  `RN 156509, Vuori, Inc., Women's apparel + Men's apparel`.
- `https://www.ftc.gov/rn-database/search?search=56323` returns
  `RN 56323, NIKE, INC.`

Both directions work on a plain GET with a query string, server-rendered, signed
out. The result table carries type, number, legal business name and product
line, which is every column the registry table has.

**The RINS Rules of Behavior do not apply to this.** They govern accounts on
`rn.ftc.gov`, which exists so a business can apply for, update or cancel its own
RN. That system's own landing page says a login is needed "only if you wish to
update or cancel the RN". We create no account, hold no password, and bypass no
access control. The decision is recorded here so nobody re-opens it later:
**do not create or automate an FTC account for this.**

Facts in a US government register are not copyrightable, so storing a company
name and republishing it with attribution is fine. What we owe the FTC is
politeness: a low request rate, and the record URL stored in `source_url` on
every row so any reader can check us.

Correction to the record: migration `00466` says the FTC RN database is
"auth-gated", which is why only six brands carry a seeded RN today. That is
wrong about the public search, and it is why this data was never gathered. The
migration note should be corrected in the same commit as the seeder.

### Seeding order

1. The roughly 180 brands already in `brand_knowledge`, searched by company
   name. These are the tags resellers actually hold.
2. Numbers already sitting in `registered_number_sightings` with no registry
   row, highest count first. The product has been collecting these; nothing has
   ever resolved them.
3. Nothing else. No speculative bulk import.

A row is written only when the FTC search returns exactly one match for the
company. Ambiguous matches go to a review queue rather than into the index,
because a wrong company name on a page that claims provenance is worse than a
blank one.

## Architecture

**URL family.** `/rn/56323`, one page per number, edge-SSR'd by a Pages
Function at `functions/rn/[number].ts`, mirroring `functions/style/[code].ts`.
Non-canonical input (`RN56323`, `rn 56323`, leading zeros) 301s to the canonical
digits.

**Hub.** `/tools/rn-lookup`, a registered public route with the search box, the
tag reader, and a list of the most-looked-up numbers. Registered in
`src/lib/seo/public-routes.ts` and `src/prerender/entry-server.tsx`, which CI
already enforces.

**Sitemap.** `sitemap-rn.xml`, its own segment, so indexation and impressions
for this family are one readable line in Search Console.

**Data path.** `functions/rn/[number].ts` reads a public JSON endpoint on the
edge service, the way the style-code page reads
`/api/content/public/style-codes.json`. Shaping lives in a new
`services/edge-functions/src/lib/public-registered-number.ts`, pure, so the
rules are unit-testable without a database.

### The indexing rule

Only a number with a resolved company is indexable. Everything else renders for
a human and carries `noindex`. `indexable` is computed in the edge lib, never in
the renderer, so the page and the sitemap cannot disagree. This is the US-2748
rule and it is the difference between a family that ranks and thousands of thin
pages dragging the domain down.

## What the page says

In order:

1. **The company.** Plain, first, above everything else. That is what they came
   for.
2. **The brands it labels**, from `brand_keys`. One company often covers
   several: URBN's RN 66170 covers Urban Outfitters, Anthropologie and Free
   People, so the page says all three and does not pretend to pick.
3. **The business type and product line** as the FTC records them, with the FTC
   record linked as the source.
4. **How many real garment tags we have seen this number on.** From the
   sightings table. Nobody else can print this line, and it is the whole reason
   this page is not a mirror.
5. **The limits, stated plainly.** An RN names the company, not the brand. A
   counterfeit prints one too. A match is corroboration, never proof. This is
   already the law in `registered-numbers.ts` and the page must not soften it.
6. **The tag reader.**

An unresolved number gets the same page with an honest blank: what the number
is, that we have no reference for it, that this means nothing bad, and the tag
reader. `no_reference` never reads as "this RN is wrong".

## The tag reader

A photo box on the hub and on every RN page. Drop a picture of the care tag and
it returns the RN, the size, the fabric content and the style code where it can
read them.

- Reuses the grade-checker defenses exactly: per-IP sliding window, the shared
  AI budget ceiling, the `rate_limited` error code, no new abuse surface.
- Anonymous. No signup wall in front of the first read.
- Every successful read writes a sighting, so the tool improves the registry it
  is built on.
- The conversion line comes after the answer, never before it: the visitor has
  just watched our AI read their garment, and the next step is grading and
  listing it.

## Testing

- Pure shaping functions in `public-registered-number.ts` tested with no
  database, matching `public-style-code_test.ts`.
- A guard that no URL in `sitemap-rn.xml` renders `noindex`, since that
  contradiction is the specific failure the style-code family already learned.
- Canonical-redirect cases: `RN56323`, `rn 56323`, `056323`, `CA 32054`.
- A case proving an unresolved number renders, is not in the sitemap, and does
  not read as a negative signal.
- The seeder tested against recorded FTC responses, not the live site.

## Out of scope

- Any bulk import of the FTC register.
- CA (Canadian) numbers as their own indexed family. The parser already handles
  them and the page will answer one, but there is no measured demand, so they
  get no sitemap entry yet.
- Value and comp data on the RN page. It was considered and cut: the page
  answers one question well rather than three adequately.

## Open questions

None blocking. The one to revisit after launch is whether the tag reader should
stay fully anonymous, which is a conversion measurement, not a design decision.
