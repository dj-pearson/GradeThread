---
title: RN number lookup — where the data comes from, and what a page may claim
aliases: [RN lookup, registered identification number, /rn/, tag reader]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ftc-rn-search.ts
  - services/edge-functions/src/lib/public-registered-number.ts
  - services/edge-functions/scripts/seed-registered-numbers.ts
  - functions/_shared/rn-render.ts
  - supabase/migrations/00708_registered_number_lookups.sql
reviewed: 2026-09-02
tags: [seo, rn, brands, contract]
summary: The FTC public RN search needs no account (00466 says otherwise and is wrong), a number is indexable only once a company is resolved, and an RN may never be presented as proof of a brand or of authenticity.
---

# RN number lookup

> **Re-reviewed 2026-09-02.** Drift flagged all four refs for US-9036's second
> half (`3c1b4477b`), which records every UNANSWERED number as demand:
> `/rn/:number` fires a fire-and-forget `record_registered_number_lookup` on a
> miss, into 00708's own table -- deliberately NOT the sightings table, because a
> typed number is demand and a sighting is OCR evidence off a real tag, and the
> public page prints the sighting count. The seeder script also gained an env
> guard so it announces what it needs before touching `supabaseAdmin` rather
> than failing inside the client (US-2661). Everything this note says about the
> render path and the blank-page contract still holds.


`/rn/:number` answers "who made this garment" from the number printed on its
care label, and `/tools/rn-lookup` is the hub with the search box and the tag
reader. Built for US-9029..US-9033 off the 2026-08-31 tool-noun keyword pull,
where `rn number lookup` and `rn number search` came back at 5,000/mo each on
Low competition with a top-of-page bid of zero.

## The FTC search needs no account, and 00466 says it does

Migration `00466` records the FTC RN database as **auth-gated** and declines to
seed registered numbers on that ground. That is why exactly six brands in a
~180-brand knowledge base carry one.

It is wrong, and the correction matters more than the original mistake, because
nobody re-checks a door they have been told is locked.

- The Rules of Behavior published at `rn.ftc.gov` govern **accounts** on the
  system a business uses to apply for, update or cancel **its own** RN. That
  system's landing page says a login is needed "only if you wish to update or
  cancel the RN".
- The **search** is a different surface: `https://www.ftc.gov/rn-database/search?search=<term>`,
  a plain GET returning server-rendered HTML with no session.
- Verified in a browser and again from the shell on 2026-08-31:
  `?search=56323` returns `NIKE, INC.`, `?search=Vuori` returns
  `Vuori, Inc.` with two product lines.

The migration is applied and immutable, so this note and the header of
`ftc-rn-search.ts` are the correction. **Do not create or automate an FTC
account for this.** We hold no credential and bypass no access control; what we
owe the registry is a low request rate, which the seeder fixes at one call
every two seconds, single threaded, halting on any non-200.

## What a page may claim, and what it may not

These come from [[brand-kb-decoder-bar]]'s fourth question and from
`lib/registered-numbers.ts`, which has held the same line since US-2211.

- **An RN names the COMPANY, never the brand.** URBN's RN 66170 covers Urban
  Outfitters, Anthropologie and Free People, so an answer is "one of these".
  `brands` is a list and is never reduced to a winner.
- **An RN is never proof.** It is public, so a counterfeit prints a real one.
  Copy says corroboration, never proof, and a test fails if the words
  *authentic* or *genuine* appear in the rendered body.
- **"No reference" is not a negative signal.** An unresolved number renders,
  says we have no record, and says plainly that the number is almost certainly
  real. It must never read as invalid, fake or suspicious.

## Indexable only once a company is resolved

`publicRegisteredNumber()` sets `indexable` from one condition — a resolved
`company_name` — and both the page and `sitemap-rn.xml` read it from there.
`indexableNumbers()` applies the same condition for the sitemap, and one test
drives both halves from a single fixture set.

A URL listed in a sitemap that renders `noindex` is the contradiction that gets
a whole section ignored. [[seo-technical-guards]] carries the general rule;
US-2748 paid for it on style codes first.

**One deliberate asymmetry:** a CA (Canadian) number renders and indexes as a
page but never enters the sitemap. There is no measured demand for the Canadian
register, and a sitemap entry is a claim that a URL is worth crawling. It looks
like a bug from either side alone, which is why it is written down and has its
own test.

## Where rows come from

`registered_number_registry` (migration `00502`) is filled by
`scripts/seed-registered-numbers.ts`, in this order and no other:

1. The ~180 brands in `brand_knowledge`, searched by `canonical_brand`. There is
   no `brand_name` column; that mistake cost a run.
2. Unresolved rows in `registered_number_sightings` (`00501`), searched by
   number, most-seen first. The product has recorded these off real tags since
   US-2211 and nothing had ever resolved them.

**Exactly one FTC match writes.** Zero is a normal skip, because most brands are
labelled by a parent under a name nobody searches. Two or more goes to a review
queue and writes nothing: `Patagonia` returns both PATAGONIA INC. and PATAGONIA
TRADING CO., and nothing on the page says which one labels the fleece in your
hand. A wrong company under a page whose whole selling point is showing its
sources is worse than no page at all.

## The queue drains, and it did not used to (US-9034)

`registered_number_sightings.resolved` is the work queue `00501` built, with an
index on `(resolved, sighting_count DESC)` to serve it. Until US-9034 the only
writer that ever set it was the admin resolve route. The seeder — the bulk path,
the one that actually empties the queue — read `resolved = false` and never
wrote it back.

Nothing looked wrong. A run that re-searches settled numbers builds the same
registry as one that skips them; it is only slower, and it gets slower every
time the product reads another tag. At one request per two seconds and a 500-row
queue, a second run repeats about seventeen minutes of requests to learn what it
already knew, against a public service this file elsewhere promises to be polite
to.

Two rules now, both in `seed-registered-numbers.ts`:

- A queue row whose `registry_key` is already in the registry is dropped
  **before** a request is spent. A sighting *is* its registry key, so unlike a
  brand we can tell without asking.
- An `--apply` run flags the sighting for the number **the FTC returned**, not
  the term searched. That resolves both origins from one call: a brand candidate
  often answers a number somebody photographed before we knew whose it was.

A dry run still writes nothing, the flag included. A failed flag logs and the
run continues, because the registry row is the deliverable and is already
written.

## Four things that would have shipped broken

All four were caught by tests that already existed, on a branch where the suite
had never been run to completion. Recording them because none is visible by
reading the feature's own files, and three of the four leave every RN unit test
green.

**`/rn/*` and `/sitemap-rn.xml` were missing from `public/_routes.json`.**
Cloudflare Pages routes a URL to a Function only if it matches an `include`
pattern there; anything else is served as a static asset. Every RN page and the
whole sitemap segment would have answered with the SPA shell in production while
every unit test stayed green, because the renderer, the payload and the sitemap
builder were all correct — nothing was wired to reach them. `routes-json.test.ts`
(US-424) catches it by walking `functions/` and demanding a pattern per route
file. It is 71 rules against Cloudflare's limit of 100.

**The hub had no conversion pitch at all.** US-9033 asks for one "after the
answer, never before it", which reads as a placement constraint and was
satisfied vacuously. The tag reader returned its four fields, offered a link to
`/rn/:number`, and stopped: no signup, no submission link, and no
`rn_lookup_cta_click` event, so the funnel could show 10,000 monthly searches
arriving and nothing about what any of them did next. The block now mirrors the
grade checker's, including US-2526's rule that the primary control goes to the
submission flow rather than to an explainer.

**`/tools/rn-lookup` declared `WebApplication` and never prerendered it.** Both
halves looked done — the route declares `jsonLdType` in `PUBLIC_ROUTES` and the
page passed nothing to `MarketingLayout` — so the markup existed nowhere at all,
and a `<SEO>` route that *had* rendered it would still have been SPA-only. US-2044
paid for this exact omission on the other two free tools; `jsonld-parity.test.tsx`
is the guard it left behind. Fixed in both places: `rnLookupJsonLd()` in
`marketing-jsonld.ts`, mirrored into `head-builder.ts`'s route map, which is the
rule `CLAUDE.md` states and the one that is easy to half-obey.

**The meta description ran 183 characters against a 160 budget.** US-435 caps it
at the snippet window, and the overflow clause was the tag reader — the half that
distinguishes the page from a free mirror. Now 143.

**`www.ftc.gov` was on no subprocessor list.** US-2527 walks the edge service for
outbound hosts and demands each one be a listed processor or a stated exception
with a reason. The seeder introduced a new one. It belongs in `NOT_A_PROCESSOR`:
traffic is one way, and the query string is a brand name or the digits off a care
label, both public facts about a product rather than about a person. We hold no
account and send them nothing about a seller, an item or a submission.

## The blank page, and why it stopped being a dead end (US-9036)

Most numbers are blank and will stay blank for a long time. The seeder reaches a
few hundred; the FTC register holds over 100,000. So the honest blank is not the
edge case, it is what nearly every visitor sees, and it used to end there: no
company, no link, and a tag reader that reads their label without being able to
say whose number it is.

`rn-render.test.ts` had a rule against it, named *"links the FTC record when
there is one, and never a dead one"*. That rule was right about the thing it was
written for and wrong about this. `source_url` is provenance, written by the
seeder only when a search actually matched, so a number nothing has answered has
none. But the FTC search URL for any number can be BUILT without running it, and
it resolves either way. It is not a dead link; it is a search we have not run,
and the test could not tell those apart.

So there are two links now, and the distinction is the contract:

- **`sourceUrl`** is the record we read. It is provenance for a claim we made,
  and it appears only with a resolved company.
- **`searchUrl`** is always set, including on a blank. It says we have not
  indexed this number and points at the official database.

Copy keeps them apart: a resolved page says "See the FTC record", a blank says
"Search the FTC register for RN 999999, the official database, which we have not
indexed yet". Printing `sourceUrl` on a blank would dress a query up as evidence.

**`renderRnBody` branches on `companyName`, not on `sourceUrl`.** The two are
gated together in the payload, so reading either one works today, and reading
the correlated one means a payload that ever carries a stale source without a
company prints one number's evidence under another. A test holds the renderer to
that independently of the payload.

The click goes to the FTC, which we were losing anyway. The page is `noindex`
when unresolved, so nothing is ranking on it to protect.

## Demand is measured now, and it is not a sighting (US-9036)

A miss used to be a pure read. Somebody typing the exact registrant they wanted
taught us nothing, and the seeder went on ranking its queue by our guess at
which brands matter.

`registered_number_lookups` (`00708`) counts them, and it is a **separate table
from `registered_number_sightings` on purpose** rather than a second column on
it. A sighting means our OCR read the number off a real garment tag, and
`/rn/:number` prints that count as the one line a mirror site cannot print.
A typed number is demand, not evidence. Folding the two together would inflate
the number the page's credibility rests on, and `00501`'s own
`CHECK (sighting_count > 0)` makes a lookup-only row impossible to represent
there honestly in any case.

Same shape otherwise: one row per registry number, no owner column and no
request identity, deny-all RLS, an increment-or-insert RPC so concurrent
lookups cannot lose a count, and a `(resolved, lookup_count DESC)` queue index.
The write is fire-and-forget after the payload is built, and only on a miss —
nobody waits on bookkeeping for an answer we already have.

**One place 00708 deliberately does NOT copy 00501.** That migration's RPC is
`SECURITY DEFINER` with a `REVOKE` on anon and authenticated, and taking the
pair across would have been a database-restart bug. US-2403: on this Postgres
image supautils decorates a permission-denied error with a GRANT hint for any
role in `supautils.hint_roles`, and building that hint segfaults the backend on
a **function** denial, killing every other session with it. `anon` is the role
behind the key in the browser bundle, so a revoked function is one HTTP call
away from restarting prod. 00501 pre-dates the finding and is tolerated on that
basis; a new file may not repeat it, and `us2403-function-revoke-gate.test.ts`
enforces that with a shrink-only allowlist.

So 00708 puts authorization in the table rather than in `EXECUTE`. The function
is `SECURITY INVOKER`, the service-role client bypasses the deny-all RLS and
writes, and anon hits an ordinary row-level refusal on the INSERT — a table
denial, which takes the normal path every deny-all table here already uses.
Worth reading before modelling anything else on 00501.

## The tag reader, and the count it earns

`POST /api/grading/public/tag-read` is anonymous and reuses
`extractTagGroundTruth`, the AutoLister's existing OCR pass. Defended exactly
like `/grade-check`: five per IP per hour with a `rate_limited` code so a limit
never reads as a bad photo, an 8 MB cap, magic-byte validation, EXIF stripping,
and the shared daily Vision ceiling. No image is persisted.

Its one write is a **sighting**, and it deliberately does not call
`recordRegisteredNumberSighting()` — that path only writes on a `no_reference`
outcome, so a number we have already resolved would never increment, and the
count on a resolved page is exactly the line no mirror site can print. Same
`00501` RPC underneath.

A field below `TAG_GROUND_TRUTH_MIN_CONFIDENCE` is dropped rather than shown. A
wrong RN sends someone to the wrong company with our name on the answer.

## Related

- [[seo-public-route-registry]] — what registering `/tools/rn-lookup` required
- [[seo-technical-guards]] — the sitemap-versus-noindex rule this family obeys
- [[brand-kb-decoder-bar]] — which entity an identifier is allowed to name
- [[INDEX]]
