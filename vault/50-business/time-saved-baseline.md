---
title: Time-saved baseline — manual minutes per task
aliases: [time saved, hours saved, time-saved meter]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/time-saved.ts
  - services/edge-functions/src/routes/flipdesk-time-saved.ts
  - src/lib/time-saved.ts
  - src/test/time-saved-baseline.test.ts
reviewed: 2026-09-04
tags: [flipdesk, analytics, growth, contract]
summary: The manual minutes each automated FlipDesk task stands in for, the source of each figure, and the rule that only tasks with an event are counted; both time-saved.ts files mirror the table and a test fails on drift.
---

# Time-saved baseline — manual minutes per task

The overview tile "You saved 6h 40m this month" (US-9207) is this table times
the number of times FlipDesk actually did each task. The figures are a
contract: `services/edge-functions/src/lib/time-saved.ts` sums with them,
`src/lib/time-saved.ts` mirrors them for the breakdown, and
`src/test/time-saved-baseline.test.ts` parses the table below and fails when
either file disagrees with it. Change the number here and in both files in the
same commit, or the build says so.

## The table

| task | minutes | source |
|---|---|---|
| photo_edit | 2 | Background removal and crop by hand in a phone editor, per photo. Owner estimate 2026-09-01 from the intake flow; replace with the measured median once US-9204's `review_approved` timing has a month of data. |
| measurements | 4 | Tape, flat lay, six fields typed, per item. Owner estimate 2026-09-01; the MeasureCard photo pass (US-1571) replaces the typing, not the flat lay. |
| title_description | 6 | Writing an 80-character title and a buyer-facing description, per listing. Owner estimate 2026-09-01. |
| item_specifics | 5 | Filling a marketplace's required specifics from the label and the garment, per listing. Owner estimate 2026-09-01. |
| comps | 8 | Searching sold comps, matching condition, picking a number, per listing. Owner estimate 2026-09-01; the largest single figure and the one most worth measuring. |
| cross_list | 7 | Re-entering one listing on a second marketplace by hand, including photos, per listing. Owner estimate 2026-09-01. |
| delist | 2 | Finding and ending one listing on a marketplace after a sale elsewhere, per listing. Owner estimate 2026-09-01. |
| relist | 5 | Copying an ended listing into a fresh one, per listing. Owner estimate 2026-09-01. |

Every source above is an owner estimate dated 2026-09-01. That is stated rather
than dressed up: the meter needs a baseline on day one, and the honest baseline
is a named estimate that a measured figure replaces. When one is replaced, the
source column says what measured it and over how many sellers.

## The counting rule

Per item and per month, the server counts only tasks that left a row behind:

| task | the event |
|---|---|
| photo_edit | `item_photos` with an `edit_recipe` or an `original_storage_path` |
| measurements | an `ai_enrichment_log` row whose suggested fields are measurement keys |
| title_description | an `ai_enrichment_log` row carrying `listing_title` / `listing_description` (listing-copy, rewrite) or `title` / `description` (extract) |
| item_specifics | an `ai_enrichment_log` row carrying `aspect_suggestions` |
| comps | a listing whose `price_set_by` is `graded` or `comp_median` (US-9205) |
| cross_list | a GradeThread-originated listing that went live on a channel other than eBay |
| delist | a completed `delist` job in `extension_work_queue`, or a listing ended with `delist_requested_at` set |
| relist | a completed `relist` job, or a listing in status `relisted` |

A task the seller skipped, or did by hand, has no row and adds nothing. A size
guess (`/ai/size`) is not one of the eight tasks and is not counted.

## Using the number in copy

The per-seller total is the seller's own and may be shown to them as is. An
aggregate (a median across sellers) may appear in marketing copy only with the
sample size stated beside it and only once it is a measured figure, under the
claim rules in [[copy-style-guide]] and the pattern
`src/test/return-analytics-claim-rules.test.ts` sets: a minimum sample before
any number is shown, and never a worse number presented as a win. No such copy
exists yet; the tile is the only reader.

## Related

- [[pricing]] — the same mirror-and-test pattern for the plan matrix.
- [[flipdesk-plan-gating]]

## 2026-09-04: the parser got CRLF-safe; the table did not change

`src/test/time-saved-baseline.test.ts` split this note on a bare newline
while the file is CRLF, so its end-anchored row regex matched nothing and
the table parsed as an empty object. All three of its cases failed on
every Windows checkout and passed in CI forever, because the runner
checks out LF. It splits on an optional carriage return now.

No minute figure and no source sentence in the table below was touched.
The estimates are still the 2026-09-01 owner estimates awaiting
measurement.
