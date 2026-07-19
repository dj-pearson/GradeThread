# GradeThread knowledge vault

An Obsidian vault. Open this folder directly in Obsidian — it is not the repo
root, it is `vault/`.

**Start at `00-index/INDEX.md`.**

## What lives here

Contracts, runbooks, decisions and taxonomy — the things code cannot tell you:
*why* a choice was made, *what* a rule requires, *what breaks* in production.

For what the code **does**, read the code. This is not API documentation.

## The folders

| | |
|---|---|
| `00-index/` | Entry point, live Dataview views, note templates |
| `10-ops/` | Deploy, rollback, backups, incidents, capacity |
| `20-domain/` | Grading, measurement, privacy, brand taxonomy |
| `30-platform/` | eBay and marketplace integration |
| `40-growth/` | SEO, content, distribution |
| `50-business/` | Pricing, unit economics, ads |
| `60-decisions/` | ADRs — why things are the way they are |
| `70-agent/` | How agents work in this repo |
| `90-archive/` | Point-in-time snapshots. Read only for history. |

Numbered prefixes sort the same in Obsidian's explorer and in `ls`.

## Adding a note

1. Copy a template from `00-index/templates/` (Obsidian: Templates plugin).
2. Fill **every** frontmatter field. `reviewed` is today and asserts you checked
   the content.
3. **Link to it from somewhere.** An unlinked note is an orphan and CI rejects
   it — a note nothing points at is a note nobody finds.
4. `npm run vault:index && npm run vault:lint` from the repo root.

Read `CONTRACT.md` before your first note. It is the only definition of the
schema, and two fields decide how CI treats your work: `source_of_truth: code`
requires `code_refs` and enables the drift guard; `type: contract` turns drift
from a warning into a build failure.

## Why it looks like this

Retrieval is **navigation, not search** — no vector database, by design
(`60-decisions/adr-0001-knowledge-vault.md`).

That choice is measured, not assumed. Navigating this vault costs **89% less**
than the corpus it replaced; grepping it blindly costs **16% more**, because it
added 89 cross-linked notes to a repo that already had 200
(`00-index/benchmark-2026-07-19.md`).

So the entry point matters more than it looks. Start at the index.

## Two readers

Humans get Obsidian's graph, backlinks and the live Dataview queries in
`00-index/live-views.md`. Agents read raw markdown and cannot run a query, so
`INDEX.md` is generated and kept in step by CI. Both come from the same
frontmatter — see `60-decisions/adr-0003-dual-consumer-vault.md`.

**Do not delete `scripts/vault-index.mjs` as redundant once Dataview is
installed.** It is the only index an agent can read.
