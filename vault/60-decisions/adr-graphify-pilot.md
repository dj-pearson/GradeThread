---
title: "ADR: Graphify pilot"
type: decision
status: accepted
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [decision, pilot, growth]
summary: The Graphify pilot, its scope and the criteria for continuing or stopping.
---
# Graphify pilot — queryable code graph for cheaper codebase Q&A

Status: **pilot / evaluation** (not wired into CI or the Ralph loop yet).

[graphify](https://github.com/safishamsi/graphify) builds a queryable knowledge
graph of a codebase (and docs/PDFs/images) so you can ask "what connects X to Y?"
and get an answer from a small graph instead of reading many raw files. Its docs
claim **~71× fewer tokens per query vs reading raw files** — which is exactly the
kind of saving we want for ad-hoc codebase questions and for auto-populating the
Ralph `relevantPaths` hints (see `scripts/ralph/README.md`).

> ⚠️ **It is a Claude Code *skill*, not a standalone DB.** It installs a
> `/graphify` slash command and builds the graph using Claude (incl. vision for
> images). So building the graph itself costs tokens *once*; the savings come
> from every subsequent **query** running against `graph.json` instead of the
> tree. Treat graph-build as an occasional batch job, not per-iteration work.

## Why pilot it on your machine, not in a web/remote session

The remote Claude Code container is **ephemeral** — a `pip install` + skill
install here does not persist to your local setup, and the graph artifacts would
be thrown away when the container is reclaimed. Run the pilot on your dev machine
(or commit the generated `graph.json` so it's reusable). The steps below are for
that local run.

## Setup (local, one-time)

Requirements: Claude Code + Python 3.10+. No extra API keys (it uses your Claude
Code auth).

```bash
pip install graphifyy   # NB: PyPI package is "graphifyy"; the CLI stays "graphify"
graphify install        # registers the /graphify skill in Claude Code
```

## Build the graph

From the repo root, in an interactive Claude Code session:

```
/graphify .                 # build graph for the whole repo
/graphify . --update        # re-merge after code changes (incremental)
/graphify . --watch         # auto-sync as files change (long-running)
```

Artifacts land in the working dir:

| Artifact | Use |
|---|---|
| `graph.json` | Persistent graph queried by `/graphify query` (commit this to reuse). |
| `graph.html` | Interactive, searchable visualization. |
| `GRAPH_REPORT.md` | High-degree nodes, surprising connections, suggested questions. |

Edges are tagged `EXTRACTED` / `INFERRED` / `AMBIGUOUS` — trust `EXTRACTED`
first; treat `INFERRED`/`AMBIGUOUS` as hints.

**Add these to `.gitignore` unless you intend to commit the graph:**
`graph.html`, `GRAPH_REPORT.md`, `obsidian/`, `wiki/`, `cache/`. Committing
`graph.json` is reasonable if you want a shared, queryable snapshot; just refresh
it with `--update` so it doesn't drift from the code.

## Query (the cheap part)

```
/graphify query "what publishes an eBay listing and what does it touch?"
/graphify query "what depends on assemblePublishContext in flipdesk-ebay.ts?"
```

Use this instead of grep-and-read sweeps for "where does X live / what calls Y"
questions — that's the ad-hoc Q&A win.

## How this connects to Ralph `relevantPaths` (#5)

The Ralph harness already passes any `relevantPaths` array on a story straight
through to the agent (it's part of `current-story.json`), and the prompt tells
the agent to read those first. graphify is the natural way to *populate* that
field without hand-curation:

1. For a story, query the graph for the files its feature touches, e.g.
   `/graphify query "files involved in <story feature>"`.
2. Write the top file paths/globs into that story's `relevantPaths` in
   `prd.json` (3–8 paths is plenty — keep it tight so it stays a hint, not a
   second tree-sweep).

This can stay manual for the highest-value stories, or be batched later with a
small script that loops the open stories through `/graphify query`. Keep paths
fresh with `--update` after large refactors, or they'll point at moved code.

## Evaluation checklist (what to decide after the pilot)

- [ ] Does graph-build complete on this repo without choking on `dist/`,
      `node_modules/`, generated files? (Scope the build to `src/`,
      `services/edge-functions/src/`, `supabase/` if it's noisy.)
- [ ] Are `/graphify query` answers accurate enough to trust for `relevantPaths`?
- [ ] Build cost vs. query savings — is the one-time graph-build token cost worth
      it given how often the graph is queried before it needs a rebuild?
- [ ] Keep `graph.json` committed (shared snapshot) or regenerate on demand?

## Related

- [[seo-distribution-and-measurement]] — how a pilot like this gets judged
- [[INDEX]]
