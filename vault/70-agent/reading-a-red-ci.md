---
title: Reading a red CI lane here
aliases: [CI is red, vault lint drift, runbook-sync, why did CI fail]
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-01
tags: [ci, agent, verification]
summary: The frontend CI job fails on knowledge guards far more often than on code, so read which STEP failed before assuming a regression.
---

# Reading a red CI lane here

**A red `CI / Lint, type-check, test & build (frontend)` usually is not a code
failure.** That job runs the knowledge guards alongside the build, and they fail
on a different thing entirely: a note whose subject changed without the note
being re-read.

Two of them, both blocking:

- **`vault:lint --strict` drift.** A `type: contract` note whose `code_refs`
  point at a file with a newer commit than its `reviewed` date is an **error**,
  not a warning. One day's edits to `ai-grading.ts` and `ebay-client.ts` turned
  **seven** notes red at once, because several contracts legitimately cite the
  same file.
- **`runbook-sync`.** Some `10-ops` notes have hand-written distillations shipped
  inside the admin UI ([[adr-0002-shipped-runbook-copies]]). Editing the vault
  note without re-reading its shipped copy fails the build, on the reasoning that
  operators read the copy during an incident and a stale copy is worse there than
  anywhere else.

## Diagnose the step, not the job

```bash
gh run view <id> --log-failed | grep -E "✗|error"
```

The step name tells you the class immediately: *Vault lint* and *Shipped runbook
copies vs vault* are knowledge guards; *Unit tests* / *Build* / *Bundle budget*
are code.

**A commit that touched no source at all can fail this job** — a `prd.json`-only
commit did, which is the cheapest possible proof that the failure is not a
regression. If you are unsure whether your change broke CI, look for a
neighbouring commit that could not have.

## What this means for how you work

Neither guard is misfiring, and neither should be loosened. They are the
same-commit rule with teeth: **if your change invalidates a note, update the note
in the same commit** ([[CONTRACT]]).

The trap is asymmetric. Editing *code* that a contract cites is easy to forget,
because nothing in the diff mentions the note. Editing a *vault note* is the
opposite — the vault edit is right there, and the thing you forget is the shipped
copy you did not know existed.

> Bumping `reviewed` without re-reading is the one failure mode neither guard can
> catch. If the change genuinely affects the distillation, fold it in; if it
> genuinely does not, say so in the note's provenance callout rather than
> silently re-dating.

## The gate that does not cover `functions/`

The reverse hazard: a green run that proved less than it looks.

`tsconfig.json` references only `tsconfig.app.json` and `tsconfig.node.json`, so
the Cloudflare Pages Functions under `functions/` are **not in the build graph**.
A type error there passes `npm run build`, `npm run build:locked`, `tsc -b` and
the whole vitest suite — and then fails when Cloudflare builds the Functions at
deploy, which is the worst place to find it.

This is not theoretical: a real `TS7053`/`TS2322` in `functions/og/social/card.ts`
went green through every standard gate.

```bash
npx tsc -p tsconfig.functions.json --noEmit   # after touching anything in functions/
```

The edge service is a third graph again (Deno, its own lane), so "the build
passed" always means *one* of three graphs.

## The mirror image: a local-only failure that is not real

The same class runs the other way on a Windows checkout. A lone `deno test`
failure citing *"markers missing"*, a verbatim-embed mismatch, or a line-content
diff on a `.md` file is almost always `core.autocrlf` smudging LF to CRLF in the
working tree while git stores LF. Linux CI checks out LF and passes, so the
"drift" exists only on your disk.

```bash
git show HEAD:<file> | grep -c $'\r'   # 0 ⇒ git has LF; your tree is the problem
```

Check that before "fixing" the document. One such test was made line-ending
agnostic rather than the doc being edited, which is the right direction of fix.

## Lane health is not uniform

Observed 2026-08-02 over the last runs: **Tenant Isolation, Security, Secret
scan, Static analysis, IndexNow and Uptime were all green**, while **CI** was the
only red lane — and its E2E job passed while the frontend job failed. So "CI is
red" says almost nothing on its own; name the lane and the step.

## Related

- [[guards-that-cannot-fail]] — the failure mode these guards are guarding against
- [[CONTRACT]] — the same-commit rule and what `reviewed` asserts
- [[adr-0002-shipped-runbook-copies]] — why the shipped copies are hand-written
- [[INDEX]]
