---
title: Vault contract
type: contract
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-18
tags: [meta, schema]
summary: The frontmatter schema every vault note must satisfy, and the rules vault-lint enforces.
---

# Vault contract

This file is the **only** definition of the note schema. Nothing else — not
`CLAUDE.md`, not a skill, not a README — restates it. If you find the schema
described somewhere else, that copy is wrong by construction; delete it and link
here instead.

Established by [[adr-0001-knowledge-vault]] (US-2042).

## Why this vault exists

The repo held 203 markdown files with no index and real duplicates: two ~363-line
env references, and three runbooks existing at both root and `docs/` at different
lengths. An agent answering "what is the deploy order" had no way to know which
copy was current. The vault's value is **consolidation**; Obsidian is packaging.

Retrieval is **navigation, not embedding** — there is no vector database here by
design. See [[adr-0001-knowledge-vault]] for that decision and its tradeoffs.

## Frontmatter schema

Every `.md` file under `vault/` must open with YAML frontmatter:

```yaml
---
title: Human-readable note title
type: runbook | contract | reference | decision | learning | moc
status: current | superseded | archived
source_of_truth: code | vault
code_refs:
  - path/relative/to/repo/root.ts
reviewed: 2026-07-18
tags: [free-form, lowercase]
summary: One sentence. Feeds the generated index.
---
```

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Need not match the filename. |
| `type` | yes | One of the six values below. |
| `status` | yes | `current` unless deliberately retired. |
| `source_of_truth` | yes | See the section below — this drives CI severity. |
| `code_refs` | yes for `source_of_truth: code` | Repo-relative paths that must exist. |
| `reviewed` | yes | ISO date. Never in the future. |
| `tags` | no | Defaults to empty. |
| `summary` | no | Falls back to the note's first sentence in the generated index. |
| `revisit_by` | no | `type: decision` only. ISO date after which vault-lint warns the decision is due a re-argument. |

### `type`

- **`runbook`** — an operational procedure someone follows under pressure.
- **`contract`** — a rule the code must obey. Strictest CI treatment.
- **`reference`** — durable facts and background. No procedure, no rule.
- **`decision`** — an ADR: context, options, decision, consequences.
- **`learning`** — something discovered the hard way, usually by an agent.
- **`moc`** — a map of content; navigation only, no knowledge of its own.

### `source_of_truth` — the load-bearing field

This is not documentation metadata. It decides what CI does when the note and the
code disagree.

- **`source_of_truth: code`** — the note *describes* code. The code wins. If the
  code changed after `reviewed`, the note is suspect and the drift guard flags it.
  Requires `code_refs`.
- **`source_of_truth: vault`** — the note *is* the authority: decisions, runbooks,
  taxonomy rationale, policy. Code cannot outvote it. `code_refs` are optional and
  informational.

Do not collapse this distinction. A `code` note that goes stale is misleading; a
`vault` note that "disagrees with the code" usually means the code has a bug.

## Rules vault-lint enforces

Implemented in `scripts/vault-lint.mjs` (US-2043) and wired into `npm run verify`
as the `verify:vault` lane (US-2044).

1. Frontmatter present and schema-valid.
2. Every `[[wikilink]]` resolves to a note that exists — including the
   `[[note|alias]]` and `[[note#heading]]` forms.
3. No orphans: every note is reachable from [[INDEX]] by link traversal. A note
   nothing links to is a note an agent will never find, which is precisely the
   failure this design trades vector search away for.
4. Every `code_refs` path exists on disk.
5. `reviewed` is a valid ISO date, not in the future.
6. Drift: for `source_of_truth: code`, if any `code_refs` path has a commit newer
   than `reviewed`, flag it. Warning by default; **error** for `type: contract`
   under `--strict`, which is what CI runs.
7. Redirect stubs (US-2047) are ≤ 5 lines and point at a note that exists.
8. Knowledge-bearing migrations (US-2059): a migration named `*knowledge*`, or
   one whose leading comment exceeds 40 lines, must be referenced by `code_refs`
   from some note. Applied migrations are immutable, so a header is a
   write-once home — US-2058 found 2,259 lines stranded that way. Migrations
   through 00478 are grandfathered by number; raising that threshold to silence
   a failure defeats the rule.
9. `revisit_by` (US-2056): a `type: decision` note whose revisit date has passed,
   and whose status is still `accepted`, warns that it is due a re-argument. A
   decision nobody revisits expired silently — which is how a deliberate "look
   again in six months" becomes a permanent default nobody re-argued.

Run it with `npm run vault:lint`. `npm run vault:fix` applies the mechanical
repairs — key ordering and stamping a *missing* `reviewed` date, nothing else.

## Drift, and what it does and does not mean

Drift is a **heuristic**: it compares the last commit date of each `code_refs`
path against `reviewed`. Plenty of commits touch a file without invalidating the
prose about it, so a drift warning means *"someone should look"*, not *"this note
is wrong"*.

That is why only `type: contract` escalates to an error. A stale contract —
a wrong rounding rule, an outdated tenant-scoping requirement — gets read as
authoritative and then implemented. A stale `reference` note merely ages.

Two exemptions:
- **`status: archived`** notes are exempt. They are supposed to describe old code.
- **Shallow git clones** disable the check entirely. With `fetch-depth: 1` every
  path reports the same commit, which would flag every note at once. CI uses
  `fetch-depth: 0`; the linter detects the shallow case and skips rather than
  producing confident nonsense.

## Re-reviewing a note

Bumping `reviewed` means you **re-read the `code_refs` and confirmed the note is
still true**.

Bumping the date to silence CI is a lie the guard cannot catch — it is the one
failure mode here that automation cannot detect, so it rests on whoever edits the
file. `--fix` deliberately refuses to touch an existing `reviewed` date for
exactly this reason: the whole value of the field is that a human asserted it.

## Folder scheme

| Folder | Holds |
|---|---|
| `00-index/` | [[INDEX]], per-area MOCs, templates, the stub registry |
| `10-ops/` | Deploy, rollback, backups, incidents, scaling, capacity |
| `20-domain/` | Grading, measurement, sync contracts, privacy |
| `20-domain/brands/` | Brand & garment taxonomy |
| `30-platform/` | eBay and other marketplace integration knowledge |
| `40-growth/` | SEO, content, distribution |
| `50-business/` | Pricing, unit economics, ads |
| `60-decisions/` | ADRs |
| `70-agent/` | How agents work in this repo; agent-authored learnings |
| `90-archive/` | Point-in-time snapshots. Exempt from drift, still link-checked. |

Numbered prefixes sort identically in Obsidian's explorer and in `ls`, and give
wikilinks a stable prefix.

## Editing rules

- **Update notes in the same commit as the work that invalidated them**, mirroring
  the US-1108 migration triple. A note fixed "later" is a note fixed never.
- **Never duplicate a fact across notes.** Link to the note that owns it. Two
  copies of a number is how this repo ended up with two env references.
- **Colocated docs stay colocated.** Service deploy docs belong next to the
  service; register them as external refs so they are findable, but do not move
  them.

## Related

- [[adr-0001-knowledge-vault]] — why this exists and what was rejected
- [[agent-knowledge-surfaces]] — how the vault relates to memory and Ralph learnings
- [[INDEX]] — start here when looking something up
