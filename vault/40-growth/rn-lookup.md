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
reviewed: 2026-08-31
tags: [seo, rn, brands, contract]
summary: The FTC public RN search needs no account (00466 says otherwise and is wrong), a number is indexable only once a company is resolved, and an RN may never be presented as proof of a brand or of authenticity.
---

# RN number lookup

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
