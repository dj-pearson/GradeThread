---
title: "ADR-0004: The drift guard stays coarse — narrow the re-read, never the trigger"
aliases: [why 13 notes drifted at once, vault lint false positives, reviewed date churn]
type: decision
status: accepted
source_of_truth: vault
code_refs:
  - scripts/vault-lint.mjs
reviewed: 2026-08-08
revisit_by: 2027-08-08
tags: [meta, vault, ci, decision]
summary: File-mtime drift detection fired on 13 notes and 8 were still accurate, but the same coarseness caught two errors that had been wrong for months — so the trigger stays, and the cost gets paid on the re-read side.
---

# ADR-0004: The drift guard stays coarse

**Date:** 2026-08-08 · **Status:** accepted · **Story:** US-2430

## Context

`vault-lint`'s drift check compares each `code_ref`'s last commit date against
the note's `reviewed` date. Newer commit ⇒ suspect. Under `--strict`, which CI
runs, that is an ERROR for any `type: contract` note.

On 2026-08-08 it fired **19 times across 13 notes at once** and the `verify:vault`
lane was red on every commit to main. Eight of those thirteen files are the same
two: `services/edge-functions/src/lib/ebay-client.ts` (≈3,000 lines) and
`services/edge-functions/src/routes/flipdesk-ebay.ts`. A one-line change anywhere
in either invalidates every note that names it.

The obvious reading is that the guard tracks commit churn on large shared files
rather than tracking whether the prose is still true, and that the fix is a finer
trigger — symbol-level refs, or hunk-overlap detection, or a per-note ignore list.

## What the re-read actually found

Thirteen notes re-read against the code, one verifier each:

| Outcome | Count |
|---|---|
| Still accurate — the commit touched an unrelated part of a shared file | 8 |
| Genuinely wrong, and the flagged commit caused it | 3 |
| Genuinely wrong, and the flagged commit had **nothing to do with it** | 2 |

That last row is the decision.

`ebay-aspect-value-limit.md` claimed `isOfferAlreadyExistsError` requires the
errorId **and** a message match, and warned against loosening it to id-only. The
code has been id-only since US-528 on 2026-06-03 — the note prescribed a guard
nobody wrote and warned against the behaviour already shipping. It was
mis-recorded at the note's first review, and it survived every review since.

`grade-authority-on-listings.md` had the wrong wire format for the
`Condition Grade` aspect value and the wrong precedence rule for when publish
overwrites a seller's value.

Neither was caused by the commit that flagged it. Both were found because
somebody was made to re-read the file. **A finer trigger — one that only fires
when the specific lines a note describes change — would have suppressed exactly
these two**, because the lines they describe had not changed. They were never
right.

## Decision

**Keep the trigger coarse. Do not add symbol-level refs, hunk-overlap detection,
or per-note ignores.**

The asymmetry decides it. A false positive costs one re-read of one file. A false
negative costs a contract note that is confidently wrong and reads as
authoritative — which is the entire failure mode `--strict` exists to prevent,
and which US-2247 already paid for once (see [[shipped-but-unwired]]).

Precision is not the goal here. The guard is not a claim that the note is wrong;
it is a claim that **nobody has looked recently**, and that claim was true all
thirteen times.

## What is actually expensive, and the cheaper fix

The cost is not the false-positive rate. It is that a re-read has no option
between "trust the date" and "read a 3,000-line file." That is worth tooling:
have the lint print the **diff hunks between the note's `reviewed` date and HEAD**
for each flagged `code_ref`, so the verifier starts from what changed instead of
from the whole file. That narrows the re-read without narrowing the trigger, and
it is the only version of "make this cheaper" that does not also make it blind.

Filed as US-2431.

## The failure mode this does NOT license

Bumping `reviewed` without re-reading. `vault/CONTRACT.md` and the `vault` skill
both say the date **asserts a re-read**, and no automation here can catch a
false assertion. A bulk `sed` over thirteen dates would have turned this lane
green in one commit and buried two errors that had already survived months.

If a batch is too large to re-read honestly, bump the ones you read and leave the
rest red. A red lane is a true statement.

## Related

- [[adr-0001-knowledge-vault]] — why the vault has no embeddings and relies on structure
- [[adr-0003-dual-consumer-vault]] — the other meta-decision about how the vault is maintained
- [[shipped-but-unwired]] — what a confidently wrong premise costs downstream
- [[INDEX]]
