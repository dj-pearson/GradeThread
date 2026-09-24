---
title: Failed reads must not become facts
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/__tests__/_supabase-read-scan.ts
  - src/test/unchecked-read-contract.test.ts
  - src/test/failed-reads.test.tsx
  - src/components/finances/filing-walkthrough-card.tsx
  - src/components/api/api-overage-card.tsx
  - src/lib/payout-breakdown.ts
  - src/pages/submission-detail.tsx
  - src/test/submission-detail-dispute-read.test.tsx
  - src/test/submission-detail-linked-item-read.test.tsx
  - src/test/submission-detail-photo-read.test.tsx
  - src/test/blocking-read-density.test.ts
reviewed: 2026-09-24
tags: [data, reliability, finances]
summary: Failed database reads must not appear as zero balances, empty inventory, completed filing checks, or defaults that can overwrite saved values.
---


> [!note] Re-reviewed 2026-09-20. All five drifted refs are the commits this
> note was EXTENDED BY, in the same commits: US-3427 (a failed dispute lookup
> withholds the dispute, not the grade report), US-3428 (a failed linked-item
> lookup withholds the nudge and re-reads before a retake), US-3433 (a failed
> photo read withholds the photos, not the grade) and US-3434 (guard the count,
> not the shape, of blocking reads). The two sections those passes added --
> "The dependent action, not the page" and "Count the consumers" -- are the
> contract this note now states, and `blocking-read-density.test.ts` is what
> holds the count. Nothing here is a claim a later change falsified.

# Failed reads must not become facts

A successful read with no rows is different from a failed read. Money,
inventory, listings and filing screens must preserve that distinction. A failed
read throws into visible error handling, stops the dependent action, or leaves
the last known result with an explicit warning. Retrying must be possible.

## Consequence review (US-3260, 2026-09-15)

The source audit identified 41 direct database reads that discarded errors,
including two inside a parallel request. Of these, 33 now check the error.
The original story's approximate count included patterns outside this scanner's
scope; it is not the measured baseline.

| Consequence | Surfaces | Required behavior |
|---|---|---|
| Wrong balance or refund limit | API credits, order totals | Show unavailable; block dependent refund submission. |
| Saved values overwritten by defaults | Item aspects, ad preferences, listing composer | Stop before writing when the prerequisite read fails. |
| Incomplete listing or margin | Listing kit, scheduled drops, autolister metadata and quality scores | Show an error instead of generating or displaying incomplete results. |
| Missing inventory or grading evidence | Catalog photos, submissions, moderation, recent grades, sourcer lookup | Surface the failure; do not infer absent inventory, photos or reports. |
| Wrong buying advice | Scout profit target | Wait for the saved target or show a retryable error. |
| False filing completion | Profile existence, receipts, snapshots and supporting filing helpers | Withhold progress and advice until all required checks load. |
| False team or settings state | Member profiles, quiet hours | Show an error and allow retry. |

The filing review also removed helper-level catch-to-zero, null and empty-list
fallbacks. Payout sale lines and item facts use `fetchAllPages` with stable
ordering; a later page failure rejects the entire result rather than publishing
partial totals. A missing payout header remains valid only after a successful read.

## The dependent action, not the page (US-3427, 2026-09-19)

"Stops the dependent action" is about granularity, and reading it as "stops the
page" costs more than the failure it guards against.

The measured case: `submission-detail.tsx` blocked the entire page when the
`disputes` lookup failed. That lookup has exactly one consumer -- whether to
offer "Dispute Grade" -- so the action to stop was filing a dispute, not
rendering the grade the seller paid for. It stood that way from 2026-09-15 and
turned the critical-path E2E red for four days.

The test to apply: name the read's consumers. Withhold those, say why, and
offer a retry. Everything the failed read does not feed still renders. What is
never allowed either way is treating the failure as an answer -- an unresolved
dispute lookup must not read as "no dispute exists", which is why `canDispute`
consults the failure flag rather than only a null row.

**The action waits for the read even when nothing failed** (SUB-11,
2026-09-24). The detail page now renders as soon as the submission and report
land, before the dispute read answers, so "not failed yet" is a third state.
`canDispute` also requires `disputesLoaded`; without it the button appeared for
the length of one round trip against an unknown. The same pass split that read
by `kind` (SUB-04): grade disputes and authenticity appeals share the table, and
an unfiltered `maybeSingle` read an appeal as a dispute, or errored forever
when a report carried both. Each section's retry (photos, linked item) now
re-runs only its own read rather than the whole page load.

**Count the consumers before you decide it is one flag and done** (US-3428, the
linked-inventory read in the same effect). That one has three, and they do not
all want the same treatment:

- A surface that renders when the row IS set needs nothing. No row, no card.
- A surface that renders when the row is NOT set has to be withheld, because it
  states the absence as a fact. Here it is the "Sell this with FlipDesk" nudge,
  which tells the seller this grade is not on an item yet.
- An ACTION that carries the value onward is the genuinely dependent one, and a
  flag is not enough for it. The retake bridge copies `linkedItemId` into a new
  submission, where a wrongly-null value quietly detaches a grade from an item
  it is already on. A press is not a render, so it re-reads; only if that fails
  does the action stop, and it says why.

**Three instances came out of one function** (US-3427, US-3428, US-3433: the
dispute lookup, the linked item, the photos). The third was found by a scan for
the shape rather than by a report, which is the argument for writing the rule
down: `grep` for a load effect that early-returns on a read the page is not
*for*. The scan that found it is two lines -- a `setError` followed within a few
lines by a bare `return`, counted per file -- and the file with four of them was
the one already known to have two defects.

`src/test/blocking-read-density.test.ts` is that scan, kept (US-3434). It does
NOT flag a blocking read; 19 of the 19 sites outside that one file are correct,
because most of these files load one thing and that thing is what the page is
for. It flags the **count**: three or more in one file, and somebody should name
the consumers. That is the signal that actually worked.

The other half of the contract -- a failed read caught and written into an empty
collection -- was scanned at the same time and is clean: 15 candidates, every one
either a busy-flag reset inside a `catch` or a read already carrying its own
failure flag. The command palette's two were fixed by US-3381 and US-2517.

## Named optional exceptions

`OPTIONAL_READS` in `src/test/unchecked-read-contract.test.ts` owns the exact
exception list and each reason: five sites as of 2026-09-24 (this line said
eight, which was stale before SUB-14 retired the passport panel's `garments`
read by giving it an error state and a retry). Count the list, not this line. These are optional passport/share
links, viewer-limited names and public-embed descriptive metadata. None supplies
a monetary amount, grading decision or write prerequisite.

The guard compares exact sites, not an interchangeable allowance.
New sites fail. Removed sites also fail until their stale exception is removed,
so fixing one does not create room for a different unchecked read.

The scanner covers direct awaited object destructures and destructures from
`Promise.all`, on literal `supabase.from` and `supabase.rpc` expressions. It
accepts an explicit error binding or `throwOnError`. It does not prove that a
bound error is used correctly, nor follow indirect client aliases. Behavioral
tests and review remain necessary for those cases.

## Verification

`failed-reads.test.tsx` checks failed prerequisites preventing writes, successful
aspect preservation, balance retry versus a genuinely missing wallet, filing
failures withholding advice, and payout pagination including a later-page error.
The source guard runs with the regular web tests.

Related: [[books-and-taxes]].
