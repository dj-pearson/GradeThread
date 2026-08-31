---
title: Public certificate read paths — there are two, and they drift apart
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00530_public_cert_rubric_factors.sql
  - services/edge-functions/src/routes/content-public.ts
  - src/pages/certificate.tsx
  - src/test/public-grade-report-view-parity.test.ts
reviewed: 2026-08-31
tags: [certificates, public, schema, gotcha]
summary: A public certificate is served by two independent projections — an edge column allowlist and a Postgres view — and adding a column to one has twice shipped as "done" while the other stayed silent.
---

# Public certificate read paths

> **Re-reviewed 2026-08-31.** Drift flagged `content-public.ts` for US-9030, the two new registered-number
> endpoints. They are additive and read only the RN reference tables; no
> certificate read path, gate or projection changed.

A certificate reaches an anonymous viewer through **two independent
projections**, each with its own column list. Neither knows about the other.

| Path | Projection | Who reads it |
|---|---|---|
| Edge endpoint | `CERT_REPORT_COLUMNS` / `CERT_REPORT_EXTRA_COLUMNS` (`routes/content-public.ts`) — an explicit allowlist string on the service-role client | the SSR certificate (`functions/cert/[id].ts`), the integrity-verify endpoint |
| Postgres view | `public.public_grade_reports` — `GRANT SELECT` to `anon` | the SPA: `src/pages/certificate.tsx` and `src/pages/embed-grade.tsx`, both `.select("*")` |

## The rule

**A new publicly-visible `grade_reports` column must be added to BOTH, in the
same commit.** Extending one and calling the story done is the default failure,
not an unusual one.

## Two fields are deliberately on the edge path only

`description` (US-2628, 2026-08-16) is the second, and it is a TRANSFORM rather
than a derived field. A submission description is usually the LISTING
description, which is HTML because eBay renders it — and both certificate
renderers print the field as escaped text, so the raw tags appeared as body
copy. `certDescriptionText()` flattens it once, in the handler.

**Re-checked when that landed, because "the edge changed what it emits" is
exactly the asymmetry this note exists to catch.** It is not one: the SPA reads
`submission.description` from the edge endpoint's response
(`certificate.tsx` fetches `/api/content/public/certificates/:id`), not from
`public_grade_reports` — and it could not come from that view in any case, since
`description` lives on `submissions` rather than `grade_reports`. So both
renderers receive the flattened text and the paths agree. The rule to carry
forward is that a transform applied in the handler covers every reader of the
handler, which is a different question from a column added to one projection.

`display_title` (US-2613) is the seller title with condition claims stripped,
so the certificate does not publish "…NWT — Grade 9.2 (NWOT)" in its own
<title>. It is returned by the edge endpoint and has no counterpart in
`public_grade_reports`, which looks exactly like the asymmetry this note
exists to catch. It is not, for two reasons worth stating so nobody "fixes"
it:

1. **It is not a `grade_reports` column.** It is derived in the handler from
   `submissions.title`, so there is nothing for a view to project. The rule
   above is about stored columns and still holds unchanged.
2. **The SPA does not need it.** `certificate.tsx` builds its document title
   and its <SEO> title from the grade and tier alone — no seller string — and
   the one place it does render `submission.title` is an on-page heading,
   where showing what the seller wrote is the intended behaviour.

So the two paths still agree on everything a reader sees. If the SPA ever
starts putting the seller title in a <title>, that changes and this field has
to reach it.

## Why it keeps happening

The two paths fail in *opposite, equally silent* ways:

- The **edge** path is a string allowlist. Forget a column and the field is
  simply absent from the JSON — no error.
- The **view** path is `select("*")` cast to `PublicGradeReportRow`. Forget the
  column in the view and the cast still compiles, because a TypeScript cast is
  an assertion the compiler trusts. The field reads `undefined` at runtime.

`undefined` is indistinguishable from "no data yet" on a column that is
legitimately NULL for most rows — which describes every column either path has
ever missed. So the bug presents as the feature not having launched.

## It has shipped this way twice

- **US-2392** — `certified_content_updated_at` (00522). Added to
  `CERT_REPORT_EXTRA_COLUMNS`, declared on `PublicGradeReportRow`, read by
  `certificate.tsx` to publish schema.org `dateModified`, and **never projected
  by the view**. Result: the SSR certificate carried a real `dateModified`, the
  SPA certificate carried `null`, for the same certificate. The story even
  shipped a test (`certificate-revision-stamp_test.ts`) pinning the edge
  allowlist — it just had no reason to look at the other path.
- **US-1997** — `rubric_key` / `factor_scores` (00231). Same shape: the edge
  allowlist was extended during activation, the view was not. Here the
  consequence was stronger than a null field: `certificate.tsx` branches on
  `factor_scores && rubric_key` to render a non-clothing factor breakdown, so
  the branch was unreachable **regardless of what the pipeline wrote**. Fixing
  the writer alone would never have made it fire.

Both were closed by migration `00530`.

## The guard

`src/test/public-grade-report-view-parity.test.ts` parses the newest
`CREATE OR REPLACE VIEW public.public_grade_reports` out of the migration corpus
and asserts every field declared on `PublicGradeReportRow` is actually projected.
It found the US-2392 instance on its first run, while being written for the
US-1997 one.

Note what it does NOT cover: the edge allowlist. A column present in the view and
missing from `CERT_REPORT_COLUMNS` is still silent. That direction is only
partly pinned, by per-story tests like `certificate-revision-stamp_test.ts`.

## Editing the view

The view is recreated **wholesale** by every migration that touches it — 00314,
00315, 00316, 00318, 00356, 00530, 00532, 00534 — each reproducing the previous SELECT list
verbatim and appending. That is the mechanism by which a column can be dropped by
accident: copy an older definition and everything added since disappears, with no
error and no data change. The parity guard is the backstop; run it after any
migration that recreates this view.

## `factor_scores` is sanitized in the view, deliberately

`factor_scores` is free-form `jsonb` on an anon-readable view, so 00530 does not
pass it through. It is rebuilt keeping only **number-valued** entries, and an
empty result collapses to `NULL` rather than `{}`.

Both halves are load-bearing:

- the number filter means a future writer cannot turn the column into a leak
  channel by stashing a note, an id or a nested object in it — the guard holds
  without trusting a writer that does not exist yet;
- the `NULLIF` matters because the client guard is `factor_scores && rubric_key`
  and **`{}` is truthy in JS**. An empty object would take the non-clothing
  branch and render a breakdown in which every factor resolves to 0.

## Related

- [[certificate-revision-provenance]] — the US-2392 column and its NULL semantics
- [[shipped-but-unwired]] — the sibling failure mode: code nothing calls
- [[INDEX]]
