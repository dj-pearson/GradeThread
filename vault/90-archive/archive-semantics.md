---
title: Archive semantics
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-18
tags: [meta, archive]
summary: What belongs in 90-archive, how CI treats it, and the rule that stops archiving from burying live work.
---

# Archive semantics

`90-archive/` holds **point-in-time snapshots**: audits, reviews, completed action
plans, and superseded designs. Content whose value is historical.

This note is `status: current` because the *rules* are current. The notes it
describes are not.

## What CI does differently here

- **Drift is not checked.** Archived notes are *supposed* to describe code as it
  was. Flagging them would drown the review queue in noise that can never be
  actioned.
- **Links are still checked.** An archived note pointing at a deleted note is
  broken, not historical.
- **`status: archived`** is required, along with an as-of date in frontmatter.

## The rule that matters most

**Extract open findings before archiving.**

An audit typically contains a mix of resolved and unresolved findings. Archiving
it wholesale moves the unresolved ones somewhere nobody looks — the finding stays
technically documented while becoming practically invisible. That is worse than
never having written it down, because it produces a false sense of coverage.

Before a document lands here, its still-open findings must be either promoted into
a current vault note or filed as `prd.json` stories. US-2057 applies this to the
existing audits (`CODE_REVIEW_2026-07-04`, `SECURITY_AUDIT_2026-06`,
`IOS_PARITY_AUDIT`, `VPAT`, and others).

## Navigation

The vault skill excludes this folder from default navigation. Agents read it only
when *history* is the question — "what did the June security audit conclude?" —
not when current state is.

## Related

- [[CONTRACT]] — the schema and lint rules
- [[INDEX]]
