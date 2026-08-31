---
title: Ops runbooks exist in four places, not two
type: reference
status: current
source_of_truth: code
code_refs:
  - src/lib/admin/runbooks.ts
reviewed: 2026-08-31
tags: [ops, runbooks, duplication, migration]
summary: Ops procedures are duplicated across repo root, docs/, and a shipped in-app admin feature — and the in-app copy is the one on-call actually reads.
---

<!-- vault-move:no-rewrite -->
<!-- Records where documents USED to live. Rewriting those paths would make the
     finding describe a state that never existed. -->

# Ops runbooks exist in four places, not two

Found 2026-07-18 while dry-running `vault-move.mjs` against `ROLLBACK.md` for
US-2047. The reference scan reported a mention in `src/lib/admin/runbooks.ts`,
which turned out not to be a stray comment.

## The four copies

| # | Where | What it is |
|---|---|---|
| 1 | Repo root — DEPLOY.md, ROLLBACK.md, INCIDENT_RESPONSE.md, BACKUPS.md, LAUNCH_CHECKLIST.md | The documents everyone assumes are canonical. *(The three doubled ones were merged into the vault by US-2049; DEPLOY/BACKUPS/LAUNCH_CHECKLIST move in US-2051.)* |
| 2 | `docs/` | Second copies of INCIDENT_RESPONSE, KEY_ROTATION, DATA_RETENTION, at different lengths — **resolved 2026-07-19 by US-2049** |
| 3 | **`src/lib/admin/runbooks.ts`** | A `RUNBOOKS` array of **7 procedures** (US-910), **shipped in the frontend bundle** |
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

US-2051 could not treat this as a two-way merge: moving the markdown without
reconciling `runbooks.ts` would have declared the ops docs "consolidated" while
the copy operators actually use sat unexamined. That reconciliation became
US-2076.

**Resolved 2026-07-19 by [[adr-0002-shipped-runbook-copies]] (US-2076): guard,
do not generate.** Both shipped copies now declare the vault note they were
distilled from and when the two were last confirmed to agree;
`scripts/runbook-sync.mjs` fails when the note moves afterwards.

The deciding facts: 2 of the 7 in-app runbooks have no vault counterpart at all,
so generation would be partial by construction, and the in-app copy is
deliberately shorter and control-linked — generating it needs an "excerpt" field
per note, which relocates the duplication rather than removing it.

Also verified then: neither of the two WRONG EDGE_ENCRYPTION_KEY procedures found
in US-2049 had been transcribed into either shipped copy.

> **Re-reviewed 2026-08-22, and this time the drift found a real gap — in a
> FOURTH place the note does not count.** `runbooks.ts` had changed because
> US-2665/US-2609 landed an operator-facing fact in `deploy.md` and the shipped
> copy: *a routine deploy produces exactly the signature of an edge event-loop
> hang*, so someone who has not been told either escalates a rollover or shrugs
> at a real hang.
>
> It reached `deploy.md` and the in-app runbook on 2026-08-17. It did **not**
> reach [[edge-hang-vs-crash-loop]] — the note whose entire subject is telling
> those two apart — until 2026-08-22. Anyone diagnosing a hang goes to the hang
> note, and the fact was in the other two copies.
>
> That is the cost of this finding stated concretely: duplication is not just
> maintenance, it decides WHICH copy a given reader will miss. The count in the
> row above was also stale (it said 418 lines; the file is 502) and is now
> stated as 7 procedures — this note warns twice below against quoting a count,
> and was quoting one.

**Do not "fix" this by deleting the in-app copy.** It is a deliberate feature
with a good rationale.

> **Re-reviewed 2026-08-31, and this one had something to carry.** Drift flagged
> `runbooks.ts` for a change that was not a re-dating: Coolify's Auto deploy on
> the edge resource is now *Manual deployments only*, so the shipped deploy
> distillation's central claim — that a push to `main` ships the edge — had gone
> false, and was corrected in place. That is the failure mode this note exists
> to name, caught in the copy on-call actually reads. The four-copies finding is
> unchanged, and the count in the table below is still not quoted anywhere.

> **Re-reviewed 2026-08-01.** Drift flagged `src/lib/admin/runbooks.ts`, which
> changed because `runbook-sync` failed CI after edits to `deploy.md` and
> `incident-response.md`: both shipped distillations were re-read, given the new
> operator-facing content, and re-dated. That is this note's thesis working
> exactly as described — the guard fired, and the copy on-call reads was updated
> rather than left behind. Nothing about the four-copies finding changed.

> **Re-reviewed 2026-08-15,** and it is now three in a row with the same shape.
> The guard fired on both copies again after the scheduled-task count moved
> 77 → 78 for the new grading-self-consistency job. Neither distillation quotes
> a count, so both were re-read, confirmed accurate, and re-dated rather than
> edited. The launch note also gained a section recording that Android is not a
> launch gate; that is a scope decision about the backlog rather than a step in
> the gate, and the shipped copy is the steps.
>
> Three consecutive no-op bumps is worth stating plainly, because the tempting
> conclusion is that the guard is noisy. It is the opposite: the copies survive
> a moving generated number precisely BECAUSE they refuse to quote one, and the
> guard is what keeps checking that the refusal still holds.
> **Re-reviewed 2026-08-09,** same cause and a smaller change. `runbook-sync`
> fired on `deploy-order` and `launch-readiness` after `deploy.md` and
> `launch-checklist.md` moved; the move was the cron COUNT going 75 → 76 for the
> new `expense-recurrence` job. Neither distillation quotes a count — one points
> at Background Jobs for the live registry, the other says "re-add every task"
> without a number — so both were re-read, confirmed still accurate, and
> re-dated rather than edited. Each entry now records what was compared, so the
> next bump does not start from the guard's message alone. Worth noting the
> shape: a generated number moving in the source note is the most common way
> this guard fires, and it is usually a no-op for the shipped copy — but only
> **usually**, which is why reading both is not optional.

## Related

- [[dns-and-routing]] — the other ops contract already in the vault
- [[adr-0002-shipped-runbook-copies]] — the decision this finding produced
- [[key-rotation]] — copy 4's source note
- [[adr-0001-knowledge-vault]] — the consolidation this complicates
- [[INDEX]]
