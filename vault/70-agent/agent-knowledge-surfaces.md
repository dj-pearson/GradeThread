---
title: Agent knowledge surfaces — who owns what
type: reference
status: current
source_of_truth: vault
code_refs:
  - CLAUDE.md
  - .claude/skills
reviewed: 2026-07-18
tags: [meta, agents, knowledge]
summary: Four places currently hold agent-facing knowledge; this note defines the intended division and tracks the unification.
---

# Agent knowledge surfaces — who owns what

Four surfaces currently hold knowledge an agent might need. They overlap, and the
overlap is the problem this folder exists to fix.

## Current state (2026-07-18)

| Surface | Size | Loaded | Problem |
|---|---|---|---|
| `CLAUDE.md` | ~134 lines | **Every turn** | Cheapest to read, most expensive to grow |
| `.claude/skills/` | 4 first-party skills, ~360 lines | On trigger | Mixes procedure with facts |
| `scripts/ralph/learnings/` | ~1,400 lines | Only if found | Parallel KB, agent-written, unindexed |
| Claude memory | ~50 files | Injected on recall | No drift guard at all |
| `vault/` | new | On navigation | — |

`.agents/skills/` is not a fifth surface. It holds **only the two vendor skills**
(`supabase`, `supabase-postgres-best-practices`) — 40 files, byte-identical to
their `.claude/skills/` copies. The four first-party skills are *not* there.

**Resolved 2026-07-19 (US-2050): kept, not deleted.** Both trees were written by
the same vendor installer in one commit (`a8657af9`), and nothing in this repo
reads `.agents/`. But that directory is the cross-framework "agent skills"
convention, so an agent tool *outside* this repo may read it. Deleting 40
duplicated vendor files to risk silently breaking such a tool is a bad trade —
the downside is invisible breakage, the upside is trivial.

Instead `scripts/skills-sync.mjs` asserts the trees stay byte-identical, in the
vault verify lane and in CI. Neither copy is *authored* here, so the risk was
never editing-drift; it was updating one and forgetting the other, leaving two
versions of the same instructions with nothing to say which is current.

**First-party skills are deliberately NOT mirrored** — one home is the correct
number, and the guard fails if an unknown skill appears in `.agents/skills/`.

## The intended division

- **`CLAUDE.md`** — pointers and triggers only. It is loaded on every turn, so
  every line has a recurring cost. Knowledge belongs behind a pointer, never
  inlined here.
- **Skills** — **procedure**. What to do, in what order, what to check before
  committing. Loaded on trigger, so they can be long.
- **Vault** — **facts**. Weights, thresholds, contracts, taxonomy, decisions,
  runbooks. Carries `code_refs` and a drift guard, which is exactly what facts
  need and procedures do not.
- **Memory** — user preferences, working agreements, and *pointers into the vault*.
  Not project knowledge.

The seam between skills and the vault is procedure-versus-fact. Procedures are
stable and belong where they trigger; facts change and need drift detection.

## Why memory needs the tightest rule

Memory is **injected rather than fetched**. If a memory entry and a vault note
disagree, memory wins by default — the agent sees it without having to look. That
makes duplicated content in memory actively harmful rather than merely redundant,
which is why US-2062 reduces covered memories to one-line pointers.

Memory also has **no drift guard**. Some entries were written months ago and name
files or flags that have since moved. Verify before relying on one.

## Unification plan

- **US-2050** — resolve the `.agents/skills` mirror.
- **US-2061** — fold `scripts/ralph/learnings/` into this folder, and redirect
  Ralph's **write** path here. Migrating the files without redirecting the writer
  just regrows the parallel KB from empty.
- **US-2062** — reconcile memory against the vault; promote, point, or delete.
- **US-2063** — split skills into procedure (stays) and facts (moves here).

## Related

- [[CONTRACT]] — the note schema
- [[adr-0001-knowledge-vault]] — why consolidation over indexing
- [[INDEX]]
