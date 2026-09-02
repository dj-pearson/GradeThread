---
title: The style-code index — what counts as evidence
aliases: [style code evidence, style_code_names, where product names come from]
type: contract
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/style-code-names.ts
  - services/edge-functions/src/lib/style-code-aspects.ts
  - services/edge-functions/src/routes/jobs-style-code-sweep.ts
  - services/edge-functions/src/lib/style-code-discovery.ts
  - services/edge-functions/src/routes/jobs-style-code-discovery.ts
  - supabase/migrations/00646_style_code_discovery.sql
  - services/edge-functions/src/lib/style-code-prospect.ts
  - supabase/migrations/00647_style_code_brand_candidates.sql
  - supabase/migrations/00628_style_code_names.sql
  - supabase/migrations/00635_style_code_submissions.sql
  - supabase/migrations/00638_drop_lulufanatics_catalog.sql
  - supabase/migrations/00639_clear_title_consensus_names.sql
  - services/edge-functions/src/lib/listing-style-code.ts
reviewed: 2026-08-21
tags: [brands, style-codes, evidence, contract]
summary: A style code's product name is ranked by WHO IS IN A POSITION TO KNOW, not by how well attested it is; listing titles were tried as a source and rejected, and copying a competitor's database was refused.
---

# The style-code index — what counts as evidence

No vendor sells a style-code database. Every brand runs a private code namespace
and publishes no mapping, so the index is assembled from evidence of varying
quality. This note is the rule for what quality means here.

## Precedence is about position, not attestation

`lib/style-code-names.ts` owns the order, and it is the only place it exists —
a rank column in `style_code_names` would be a second copy free to drift.

| Source | Who that is |
|---|---|
| `official` | The brand published this name. Nothing outranks the manufacturer. |
| `admin` | A human operator with the whole index in front of them. |
| `seller` | The person holding the garment corrected us. They can read the tag. |
| `consensus` | Marketplace listings that DECLARE this code. |
| `public` | A visitor to the lookup told us. Cannot stand on one report. |

> **Confidence does not decide this.** A consensus over forty listings can carry
> a higher number than a one-off seller correction and still lose. The question
> is not "which is better attested" but "who is in a position to know".

## Listing TITLES were tried as a source and rejected (US-2751)

The sweep originally took the run of words most eBay listing titles shared for a
code. It shipped, and the owner rejected it. Two reasons, and the second is the
one that is easy to miss:

1. **A title is marketing text.** A seller who bought the garment with no tag
   beyond a size dot writes their best guess. A consensus over guesses is a
   confident guess.
2. **We were reading ourselves.** Our own sellers publish to eBay with titles
   our AI wrote, so those titles came back as independent corroboration — three
   copies of one guess, agreeing because they share an author. A corroboration
   threshold does nothing about that, because the copies genuinely agree.

What replaced it: a listing contributes a name only by declaring the style code
in a **structured item specific** (`Style Code` / `MPN` / …) and naming a product
in one (`Model` / …). One such listing outweighs three agreeing titles, because
it is evidence of a different kind rather than more of the same. Our own
listings are excluded by `platform_listing_id`.

Titles are still **recorded** as observations (00503). They are evidence,
correctly labelled as weak, and an admin should see what the market called
something even when that is not good enough to publish.

## Copying a competitor's database was refused (US-2750, 00638)

Migrations 00636/00637 built a crawler for lulufanatics.com and reached
production before being withdrawn. That site's terms prohibit scrapers in as
many words, and the database is one person's hand-built work.

The withdrawal is recorded because the reasoning outlives it: **the index is
built from sources we are entitled to read** — marketplace listings under the
eBay API's terms, sellers correcting us, visitors holding the garment, and the
brand's own published names where they can be obtained. Speed is not a reason to
change that.

`00638` also removed their `applied_migrations` rows, so the applied set matches
the shipped set and neither number became a phantom. They stay skipped in
`KNOWN_GAPS` anyway, because reusing them would confuse the history.

## Lululemon's own catalogue cannot fill this (measured, not assumed)

Asked directly on 2026-08-19/20:

- `robots.txt` **permits** product crawling for `User-Agent: *`.
- The product sitemap serves ~3,700 US products with names in the URL.
- Product **pages** refuse a non-browser client outright (`400 GE401001`).
- **Zero** of those URLs are keyed by a tag style code — the catalogue keys on an
  internal product id (`prod20000550`), and the index keys on the number printed
  in the size dot.

So even a permitted, perfect crawl yields id → name while we need code → name.
There is no join, and scraping harder does not create one. `--fetch` in
`scripts/seed-official-style-names.mjs` re-measures all four facts on demand, so
this claim can be rechecked rather than believed.

## Two directions fill the index, and only one of them starts from a code

The **sweep** (`jobs-style-code-sweep`, hourly) is reactive. It takes codes we
have already met — off a tag a seller photographed, or already in the index —
and asks the market what they are. Its ceiling is the set of garments that have
passed through the building.

The **crawl** (`jobs-style-code-discovery`, nightly, US-2782) runs the other
direction. It pages a brand's live listings and keeps whatever codes sellers
have already typed into eBay's structured fields, so a code nobody here has
listed can be answered before anyone asks for it. A per-brand cursor
(`style_code_discovery_state`) is what makes it a crawl rather than a nightly
re-read of page one.

**The evidence rule does not change between them.** Both call
`declaredStyleCode` and `declaredProductName` from `lib/style-code-aspects.ts`;
neither has a softer copy. A title cannot create a code and cannot create a
name, in either direction. Both exclude our own eBay listing ids first, so our
AI-written specifics cannot come back as independent market corroboration.

What differs is the observation `source`: the crawl writes `discovery` and the
sweep writes `market_verify`. Same quality of evidence, different act, and the
index is worth less if a found code and a verified code are indistinguishable.
Names from both enter at `consensus`, sharing one confidence band
(`aspectNameConfidence`) so the two cannot drift apart.

The crawl's brand pool is `brand_knowledge` — every brand we hold background
knowledge on, not Lululemon alone (owner decision, 2026-08-21). Widening the
crawl is not widening the public `/style/:code` surface, which stays
Lululemon-only until a brand-collision rule exists.

## The listing path reads the index, and files under the right code (2026-09-02)

Until this date the AutoLister never read `style_code_names` at all, and the
code it filed mined names under came from the sneaker resolver, which is null
for apparel. So the market_verify direction was starved at its source: a
Lululemon garment with a legible code contributed nothing and learned nothing.

`lib/listing-style-code.ts` now files mined names under the OCR'd code
(canonical spelling), and reads a resolved name back for the title and the
Model aspect. The evidence rule is unchanged in both directions: a listing
TITLE still cannot create a name, an observation-only name is offered to the
model as an unverified candidate and written nowhere, and our own listings are
still excluded by id. `scripts/backfill-tag-reads.ts` reads the index and never
writes it.

## Which brands get a crawl budget is measured, not chosen

The crawl walks `brand_knowledge`, so it can only reach brands somebody already
researched by hand. US-2786 added a survey for the rest, and two things about it
are contract rather than implementation detail.

**It cannot mine the crawl's own listings.** The obvious design — read the Brand
aspect off the listings discovery already fetched — is circular: the crawl
searches WITH an eBay Brand aspect filter, so every listing it sees carries the
brand it searched for. The story was written that way and was wrong about it.
The survey therefore runs its own UNFILTERED walk of eBay's clothing category,
newest first, with its own cursor.

**The ranking is a rate, not a volume.** A brand is worth a crawl budget in
proportion to how often its sellers fill eBay's Style Code box, not how many
listings it has. A brand with a million listings and nobody filling that field
yields nothing; a small brand whose sellers all fill it yields on every page.
`tallyCandidates` sorts by that rate, and the admin surface shows it as a
percentage, so the SQL and the UI cannot form separate opinions about what
"most promising" means.

Two guards on top:

- The survey does not run until every curated brand has been crawled AND gone
  flat. A pool with one never-crawled brand left is not exhausted — that brand
  may be the best one, and surveying strangers first is the expensive way to
  find out.
- A candidate never becomes a `brand_knowledge` row on its own. Promotion goes
  through the US-1718 sourced seed flow, and `style_code_brand_candidates` has
  no `source_url` column precisely because a tally is a measurement rather than
  a claim about a brand. Marking a candidate promoted is REFUSED while no
  `brand_knowledge` row exists, so the status cannot claim the crawl covers a
  brand it does not.

Codes found for an uncurated brand are still kept. A brand with no
`brand_style_codes` decoder has no canonical form, so those rows are filed under
the plain normalized code and a later decoder re-keys them the way US-2714
re-keys Lululemon's four spellings.

## Related

- [[brand-kb-decoder-bar]] — when a tag code may recover a brand at all
- [[sync-source-of-truth]] — the wider provenance model these sources feed
