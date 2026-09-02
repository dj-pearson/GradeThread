---
title: Certificate revision provenance — when a certificate's scores changed
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00522_grade_report_certified_content_updated_at.sql
  - services/edge-functions/src/lib/grade-adjustment.ts
  - services/edge-functions/src/routes/content-public.ts
  - services/edge-functions/src/tests/certificate-revision-stamp_test.ts
reviewed: 2026-09-02
tags: [grading, certificates, provenance, seo]
summary: A certificate records when its certified content was last rewritten in place; NULL means never revised, and a regrade must never set it.
---

# Certificate revision provenance

> **Re-reviewed 2026-09-02.** Drift flagged `routes/content-public.ts` for
> US-9036, which records an unanswered `/rn/:number` lookup as demand. That is
> the registered-number surface sharing a file with the certificate reads; no
> certificate, revision or provenance path changed.


> **Re-reviewed 2026-08-31.** Drift flagged `content-public.ts` for US-9030, which adds two anonymous
> registered-number endpoints beside the existing ones. It reads
> `registered_number_registry` and `registered_number_sightings` only, and
> touches no certificate handler, revision or provenance field.

> **Re-reviewed 2026-08-17.** Drift flagged `content-public.ts` for `b324cb03`,
> which flattens a submission description from HTML to plain text before the
> certificate prints it (US-2628). That is a rendering fix on a field this note
> does not govern. `content_revised_at` semantics — NULL means never revised, a
> regrade must never set it — are unchanged, and nothing in that commit writes
> the column.

> [!note] Re-reviewed 2026-08-15 — the drift was a neighbouring field
> `content-public.ts` changed, so the guard fired. The change adds
> `display_title` to the certificate payload (US-2613): the seller title with
> condition claims stripped, for our headline surfaces. It touches nothing this
> note describes — the revision chain, the superseded-by resolution and the
> what-changed provenance are all untouched. Re-read and re-dated, not edited.

## The column

`grade_reports.certified_content_updated_at` (00522) — when this certificate's
**certified content** (scores, tier, integrity hash) was last rewritten in place
by a human-review adjustment.

**NULL means never revised.** That is the truthful answer, not a missing value:
an unrevised certificate has no modification date distinct from its publication
date.

## Why it exists, and why it is sharper than missing metadata

`grade_reports` had `created_at` (00001) and `superseded_at` (00150) and nothing
else. A human-review adjustment rewrites `overall_score`, `grade_tier`, all five
factor scores, `content_hash`, `content_signature` and `integrity_version` on a
**live, publicly-served** row.

The integrity hash is what makes this matter. That hash exists so a buyer can
verify a certificate has not been tampered with — and a legitimate adjustment
**recomputes** it. So the certificate verified clean both before and after a score
change, with nothing on the row marking that one happened.

That is not a tamper hole: the change is authorised and audited in
`human_reviews`. But the certificate itself carried no evidence of its own
revision, and `human_reviews.reviewed_at` is not something a buyer reading a
certificate can see.

## A column, not a derivation

The alternative was `max(human_reviews.reviewed_at)` per report — no migration
needed. The column won for three reasons:

1. **It survives a `human_reviews` purge.** That is operator data with a
   retention story; the certificate is a public durable artefact. Deriving a
   public fact from a prunable table means the certificate silently loses its
   revision date one day.
2. **It does not couple the public certificate read to an operator table.** That
   read is unauthenticated on the service-role client, where the entire defence
   is a narrow column allowlist. Adding a join to an operator table is the exact
   direction that surface must not move in.
3. **It is honest about what it means.** `reviewed_at` is when a human reviewed.
   This is when the certified content *changed*. Usually the same moment — but a
   review that changes nothing must not move the date.

## Two rules

**The stamp lives inside the certificate branch.** An adjustment to an
*uncertified* report has no certificate to have revised; stamping one would put a
modification date on something never published.

**A REGRADE must never set it.** 00150 creates a NEW `grade_reports` row with a
NEW `certificate_id` and nulls the old one's. The new certificate's modification
date **is** its publication date, so emitting one would tell a crawler that a
fresh certificate had been edited. A test asserts there is exactly **one** writer
of this column in the whole edge service.

## Public exposure

It is in `CERT_REPORT_EXTRA_COLUMNS`, not the genesis set — so the US-1945 42703
fallback still serves certificates on a database where 00522 is unapplied.

Exposing it is a deliberate allowlist decision. It reveals nothing private: *that*
a certificate was revised, and when, is what someone verifying it is entitled to
know, and it is precisely the fact the integrity hash cannot carry.

## schema.org `dateModified`

This answers US-2071 AC3. Both the SPA (`certificateLd`) and the cert SSR Pages
Function (`certificateProductLd`) emit `dateModified` **only** when the column is
set, and omit the field entirely otherwise — not `dateModified: null`, and never
echoing `datePublished`.

The byte-equality test in `json-ld.test.ts` exercises **both** cases. That matters
for a reason worth carrying: US-2071 found the SSR mirror had no `dateModified`
field at all while that test stayed green, because the fixture omitted it. **A
guard whose fixture omits the field under test cannot fail.**

## Related

- [[public-certificate-read-paths]] — **read this before trusting that the
  column is public.** US-2392 extended the edge allowlist and not the
  `public_grade_reports` view, so the SPA certificate's `dateModified` was null
  while the SSR one was correct. Fixed by migration 00530.
- [[grading-scale-and-weights]] — what the scores mean.
- [[grade-accuracy-guarantee]] — what a revision can be triggered by.
