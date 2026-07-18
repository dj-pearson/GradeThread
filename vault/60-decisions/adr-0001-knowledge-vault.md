---
title: "ADR-0001: Knowledge vault as an agentic wiki, not a vector index"
type: decision
status: accepted
source_of_truth: vault
code_refs: []
reviewed: 2026-07-18
tags: [meta, knowledge, retrieval]
summary: Consolidate 203 scattered markdown files into one navigable wiki; retrieve by link traversal rather than embeddings.
---

# ADR-0001: Knowledge vault as an agentic wiki

**Date:** 2026-07-18 · **Status:** accepted · **Epic:** US-2042 → US-2067

## Context

A survey of the repo on 2026-07-18 found **203 markdown files** outside
`node_modules`, with no index and no ownership rules. Concretely:

- `ENV_REFERENCE.md` (364 lines) and `ENVIRONMENT.md` (363 lines) — a near-duplicate
  pair on the same topic, with no marker for which is current.
- `INCIDENT_RESPONSE.md`, `KEY_ROTATION.md` and `DATA_RETENTION.md` each exist in
  **both** the repo root and `docs/`, at different lengths.
- `.agents/skills/` duplicates the two **vendor** skills (`supabase`,
  `supabase-postgres-best-practices`) byte-for-byte — 40 files also present under
  `.claude/skills/`. It does *not* contain the four first-party skills.
- Wikilinks in the `US-716` style were already in use in 7 files and **all of them
  dangle** — they point at story IDs with no backing note.
- Roughly 830 lines of brand and garment taxonomy live in the headers of five
  `*_brand_knowledge.sql` migrations. Migrations are immutable once applied, so
  that knowledge is write-once and cannot be corrected where it sits.
- Three separate agent knowledge bases exist in parallel: `.claude/skills/`,
  `scripts/ralph/learnings/` (~1,400 lines), and the Claude memory directory (~50 files).

The cost is not disk space. It is that an agent answering a routine question
("what is the deploy order?", "which sites must round in lockstep?") has no
reliable way to find the current answer, and no way to detect that it found a
stale one.

## Options considered

**1. Do nothing.** Free. The duplicate-runbook and dangling-link problems are
already several months old and have not self-corrected; there is no reason to
expect them to.

**2. Classic RAG — embed the corpus into a vector store.** Handles scale well and
needs no reorganisation. Rejected: it would index the duplicates rather than
resolve them, returning both copies of the env reference with no signal about
which is right. It also adds a service to run and keep in sync, and its retrieval
is not inspectable — when it returns the wrong chunk there is nothing to read.

**3. Agentic wiki (Karpathy-style) — markdown, links, a generated index, no
embeddings.** The LLM navigates structure it can also *write*. Chosen.

**4. Mirror docs into a vault, kept in sync by a script.** Zero breakage risk.
Rejected: it doubles the maintenance surface and saves no tokens, which defeats
the entire purpose. A mirror is a second source of truth wearing a costume.

## Decision

Build `vault/` as a single navigable markdown wiki. Specifically:

- **Retrieval is link traversal**, seeded by a generated index. No vector database.
- **Migrations are moves, not copies** — each doc physically relocates and leaves a
  ≤5-line redirect stub, swept in US-2065.
- **Every note declares `source_of_truth` and `code_refs`**, so staleness is
  *detectable by CI* rather than a matter of discipline. See [[CONTRACT]].
- **The index is capped at 400 lines.** An agent reads one index, follows at most
  two hops, and stops. Uncapped, this rebuilds the original problem with extra steps.

## Consequences

**Accepted costs.** ~78 files move, and every reference to them in `CLAUDE.md`,
skills, CI and scripts must be rewritten — done mechanically by `vault-move.mjs`
(US-2047). Notes now carry a maintenance obligation: the drift guard produces work,
which US-2067 turns into a bounded review queue.

**Known limits.** Karpathy's approach is reported to degrade somewhere around
80–100 dense articles; this corpus is larger, which is why the folder taxonomy and
the index cap matter more here than in the original demonstration. If navigation
starts failing, the fix is better MOCs and tighter notes before it is embeddings.

**The premise is measured, not assumed.** US-2064 benchmarks ~12 retrieval tasks
before and after, and is explicitly permitted to report a negative result. Stub
deletion (US-2065) is sequenced *after* that benchmark so the irreversible step
follows the evidence.

**Deliberately out of scope.** Per-story notes generated from `prd.json` were
considered and rejected — 1,884 archived stories would swamp the index. The
dangling story-ID links are therefore *resolved or de-linked* (US-2056), not
given backing notes. Story history stays in `prd.archive.json`.

## Related

- [[CONTRACT]] — the schema this decision requires
- [[agent-knowledge-surfaces]] — the three KBs this consolidates
- [[brand-taxonomy-overview]] — the highest-value extraction target
