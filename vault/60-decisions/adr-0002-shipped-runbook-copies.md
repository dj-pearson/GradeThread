---
title: "ADR-0002: Guard the shipped runbook copies, do not generate them"
type: decision
status: accepted
source_of_truth: vault
code_refs:
  - src/lib/admin/runbooks.ts
  - services/edge-functions/src/lib/integrations-watchdog.ts
  - scripts/runbook-sync.mjs
reviewed: 2026-07-19
revisit_by: 2027-01-19
tags: [meta, ops, runbooks, drift]
summary: The in-app runbooks and rotation registry stay hand-written with a staleness guard, because generating them would either flood the UI or require an excerpt field that is a second copy anyway.
---

# ADR-0002: Guard the shipped runbook copies, do not generate them

**Date:** 2026-07-19 · **Status:** accepted · **Story:** US-2076
**Revisit by:** 2027-01-19

## Context

Ops knowledge lives in four places ([[runbook-copies]]). Two are TypeScript that
**ships to users**, and no markdown edit reaches either:

- **`src/lib/admin/runbooks.ts`** — 7 in-app runbooks (US-910), rendered in the
  admin UI, searchable from the command palette, each deep-linked to the admin
  controls it governs. This is what on-call reads **during an incident**.
- **`integrations-watchdog.ts`** — `KEY_ROTATION_REGISTRY`, the rotation cadences
  restructured as typed data so the watchdog can compute what is overdue.

Neither is a mistake. Putting the playbook where the controls are is the point of
US-910, and the watchdog needs cadences as data, not prose. But both were
**completely unguarded**: US-2049 found two mutually contradictory
`EDGE_ENCRYPTION_KEY` procedures in the markdown, *both wrong*, and nothing would
have stopped either being transcribed here.

## Safety check first

Verified 2026-07-19 before deciding anything: **neither wrong procedure reached
the shipped copies.** `runbooks.ts` does not cover `EDGE_ENCRYPTION_KEY` at all.
The watchdog's entry says rotation "requires dual-key re-encryption of stored
eBay tokens" and defers to [[key-rotation]] — which is true, and is the right
shape: record the constraint, link the procedure.

## Options considered

**1. Generate the in-app runbooks from vault notes at build time.** One source,
drift impossible. Rejected on three counts:

- The in-app copy is **deliberately different** — shorter, ordered for reading
  under pressure, and carrying `controls[]`, `keywords[]`, `category`, `slug`.
  Generating it means either dumping a 200-line runbook into a UI that needs six
  steps, or adding an "in-app excerpt" field to every note — which is a second
  copy wearing a costume, with the drift moved rather than removed.
- **2 of the 7 runbooks have no vault counterpart at all** (`cron-jobs`,
  `kill-switches`), so generation is partial by construction and the codebase
  ends up with both mechanisms anyway.
- It couples the frontend build to vault markdown parsing: a note format change
  breaks the build.

**2. Keep hand-written, add a staleness guard.** Chosen.

**3. Delete the in-app copy and link to the vault.** Rejected outright — it
removes the feature. An operator mid-incident should not be reading a knowledge
base in another tab.

## Decision

Keep both copies hand-written. Each declares the vault note it was distilled
from and when someone last confirmed the two agree:

```ts
sourceNote: "vault/10-ops/deploy.md",
reviewed: "2026-07-19",
```

`scripts/runbook-sync.mjs` fails when a `sourceNote` has a commit newer than its
`reviewed` date. It runs in the `vault` verify lane and in CI.

This is the [[CONTRACT]]'s `code_refs` + `reviewed` mechanism **inverted** — there
the note points at code, here the code points at the note. Reusing a proven
mechanism beat inventing one.

## Consequences

**What this cannot do, stated plainly.** It detects that the source *moved*, not
that the distilled text is *wrong*. A commit touching `deploy.md` fires the guard
whether or not it invalidated the in-app summary. Same heuristic as vault drift,
accepted for the same reason: a cheap signal that something needs a human eye
beats no signal, and semantic comparison is not available.

**Bumping `reviewed` asserts a human re-read both.** Doing it to silence CI is
the one failure mode no automation here can catch — identical to the vault's
re-review rule, and it rests on the same discipline.

**The 2 untracked runbooks are reported as warnings**, not hidden. If either ever
gains a vault counterpart, tag it.

**Reversible.** If the guard proves too noisy or gets ignored, generation is
still available. The reverse — un-generating once notes carry excerpt fields — is
much harder, which is part of why this direction was chosen first.

**Revisit 2027-01-19** (enforced by the `revisit_by` lint rule): if the guard has
fired repeatedly and nobody acted, that is evidence for generation, not for a
longer leash.

## Related

- [[runbook-copies]] — the four-copy inventory this addresses
- [[key-rotation]] — where the two wrong procedures were found
- [[CONTRACT]] — the drift mechanism this inverts
- [[adr-0001-knowledge-vault]] — the epic this sits inside
