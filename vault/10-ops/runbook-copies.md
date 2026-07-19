---
title: Ops runbooks exist in three places, not two
type: reference
status: current
source_of_truth: code
code_refs:
  - src/lib/admin/runbooks.ts
reviewed: 2026-07-18
tags: [ops, runbooks, duplication, migration]
summary: Ops procedures are duplicated across repo root, docs/, and a shipped in-app admin feature — and the in-app copy is the one on-call actually reads.
---

<!-- vault-move:no-rewrite -->
<!-- Records where documents USED to live. Rewriting those paths would make the
     finding describe a state that never existed. -->

# Ops runbooks exist in three places, not two

Found 2026-07-18 while dry-running `vault-move.mjs` against `ROLLBACK.md` for
US-2047. The reference scan reported a mention in `src/lib/admin/runbooks.ts`,
which turned out not to be a stray comment.

## The three copies

| # | Where | What it is |
|---|---|---|
| 1 | Repo root — DEPLOY.md, ROLLBACK.md, INCIDENT_RESPONSE.md, BACKUPS.md, LAUNCH_CHECKLIST.md | The documents everyone assumes are canonical. *(The three doubled ones were merged into the vault by US-2049; DEPLOY/BACKUPS/LAUNCH_CHECKLIST move in US-2051.)* |
| 2 | `docs/` | Second copies of INCIDENT_RESPONSE, KEY_ROTATION, DATA_RETENTION, at different lengths — **resolved 2026-07-19 by US-2049** |
| 3 | **`src/lib/admin/runbooks.ts`** | A 378-line `RUNBOOKS` array (US-910), **shipped in the frontend bundle** |

| 4 | **`services/edge-functions/src/lib/integrations-watchdog.ts`** | `KEY_ROTATION_REGISTRY` — the rotation **schedule** encoded as structured data (found 2026-07-19, US-2049) |

Copy 3 is not a link to the markdown. It is operational prose hand-distilled into
TypeScript string literals, each runbook deep-linked to the admin control it
governs (`controls[]`), rendered in-app and searchable from the command palette.

Copy 4 is the same move applied to a different runbook: the rotation cadences
from `KEY_ROTATION.md` transcribed into a typed registry so the Integrations
Watchdog can compute what is overdue. Its own comment says it is
"`KEY_ROTATION.md` encoded as data", and it has a test
(`integrations-watchdog_test.ts`) asserting the encoding matches the document —
which is closer to a guard than copies 2 and 3 have, but the test pins the
*shape* of the split, not that the cadences still match the prose.

## The pattern, not the instance

This is not two accidents. It is a **habit** in this codebase: operational
knowledge gets hand-transcribed from markdown into TypeScript so a feature can
use it. Each instance is individually reasonable — the in-app runbooks and the
watchdog registry are both good ideas — and each one creates a copy that no
markdown edit will ever reach.

Expect more. When migrating any ops document, grep the source tree for its
filename before declaring the move complete; `vault-move.mjs` reports these as
residual mentions precisely because they need a human decision.

## Why this is the copy that matters

The in-app runbooks are what an operator reads **during an incident**, with the
controls right there. That is the whole point of US-910, and it is a good idea.

It also means the highest-stakes copy of every ops procedure:

- is **not** the one anyone edits when they update a runbook,
- has **no** drift guard of any kind,
- and lives in a `.ts` file, so nobody updating `ROLLBACK.md` will think to look
  at it.

A markdown-only consolidation would leave this untouched and would *increase* the
risk: the repo copies get tidied and cross-linked, look authoritative, and the
shipped copy silently diverges further.

## Consequences for the migration

**US-2051 must treat this as a three-way reconciliation, not a two-way merge.**
Moving the markdown into `vault/10-ops/` without reconciling `runbooks.ts` would
declare the ops docs "consolidated" while the copy operators actually use sat
unexamined.

Whether the right end state is *generate the in-app runbooks from vault notes at
build time* or *keep them hand-written and add a drift guard* is a real design
question with a cost either way — generation constrains what the in-app copy can
say and how it links to controls; a guard is cheaper but still relies on someone
acting on it. That decision belongs in US-2051, recorded as an ADR.

**Do not "fix" this by deleting the in-app copy.** It is a deliberate feature
with a good rationale.

## Related

- [[dns-and-routing]] — the other ops contract already in the vault
- [[adr-0001-knowledge-vault]] — the consolidation this complicates
- [[INDEX]]
