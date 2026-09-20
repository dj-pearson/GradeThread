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
reviewed: 2026-09-19
tags: [data, reliability, finances]
summary: Failed database reads must not appear as zero balances, empty inventory, completed filing checks, or defaults that can overwrite saved values.
---

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

## Named optional exceptions

`OPTIONAL_READS` in `src/test/unchecked-read-contract.test.ts` owns the exact
eight-site exception list and each reason. These are optional passport/share
links, viewer-limited names and public-embed descriptive metadata. None supplies
a monetary amount, grading decision or write prerequisite.

The guard compares exact sites, not an interchangeable allowance of eight.
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
