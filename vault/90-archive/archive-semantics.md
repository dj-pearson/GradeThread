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


## What actually happened at the first archive (US-2057, 2026-07-19)

Five documents were considered. The extract-open-findings rule changed the
outcome for three of them, which is the argument for having the rule:

| Document | Outcome |
|---|---|
| `CODE_REVIEW_2026-07-04` | Archived, but only after verifying its six criticals were closed. ~87 lower-tier findings were **not** verified — filed as **US-2089** rather than archived over. |
| `SECURITY_AUDIT_2026-06` | Archived clean; the document itself states no open items. |
| `IOS_PARITY_AUDIT` | Two open items had **no covering story anywhere**. Filed as **US-2090** first. |
| `ANDROID_CONVERSION_PLAN` | Archived as superseded by the 51-story Android epic. |
| `VPAT` | **Not archived.** See below. |

### The VPAT exception

US-2057 listed the VPAT for archiving. It was routed to `20-domain` as
`status: current` instead.

A VPAT asserts conformance with WCAG 2.1 AA, Section 508 and EN 301 549 **to
customers and procurement**. Unlike an audit — which is true of a moment — a
conformance report must describe the product as it is now. A stale VPAT is not
merely outdated; it is a misrepresentation to the people relying on it.

The general rule this illustrates: **archive what was true THEN; keep current
what must be true NOW.** Age is not the test. A six-month-old audit is
archivable; a six-month-old compliance claim is a liability.

## Related

- [[CONTRACT]] — the schema and lint rules
- [[accessibility-conformance-vpat]] — the document this rule kept OUT of the archive
- [[INDEX]]
