---
name: vault
description: "Use when you need PROJECT KNOWLEDGE rather than code: how to deploy or roll back, what a contract requires, why a past decision was made, brand/garment taxonomy, pricing structure, marketplace gotchas, or where a runbook lives. Also use before ADDING or EDITING any note under vault/. Encodes the cheap-first retrieval protocol (INDEX first, two hops max, then grep), the procedure-vs-fact split between skills and the vault, and the same-commit update rule."
metadata:
  author: gradethread
  version: "1.0.0"
---

# Knowledge vault — how to read and write it

`vault/` is the project's knowledge base: contracts, runbooks, decisions and
taxonomy. It is a **navigable wiki, not a search index** — there is no vector
store and no embeddings (see `vault/60-decisions/adr-0001-knowledge-vault.md`).
Retrieval works because the structure is good, so it only stays working if you
follow the structure.

## Reading: cheap first, and stop early

1. **Read `vault/00-index/INDEX.md`.** One page, capped at 400 lines, every note
   listed with a one-line summary. This is always the first move.
2. **Follow at most two link hops.** Index → note is one. Note → related note is
   two. That should be enough.
3. **Only then grep the codebase.**

If you find yourself on a third hop, or back at the index for a second pass, the
taxonomy has failed for that question. **Say so** — a missing index entry or a
missing link is a fixable bug, and reporting it is worth more than quietly
working around it.

### When NOT to use the vault

For questions about **what the code does**, go to the code. Function signatures,
component props, route handlers, current behaviour — the vault will be vaguer
than the source and may be out of date. The vault is for the things code cannot
tell you: why a decision was made, what a rule requires, what breaks in
production, what a number means.

Rough test: if `Grep` would answer it exactly, grep. If the answer is a *reason*,
a *procedure*, or a *constraint*, start at the index.

`vault/90-archive/` is excluded from normal navigation. Read it only when
*history* is the question — "what did the June security audit conclude?", not
"is this secure?".

Every archived note carries a dated provenance callout saying what was verified
and what was not. **Read that callout before quoting anything from an archive**:
an audit's unchecked boxes usually mean "nobody updated the document", not
"still open", and treating them as open work is how a closed finding gets
re-litigated. Where a snapshot left real work behind, the callout names the
story that carries it.

## The procedure / fact split

Skills and the vault do not overlap, and it matters which you reach for:

- **Skills carry procedure** — what to do, in what order, what to check before
  committing. Loaded on trigger.
- **The vault carries facts** — weights, thresholds, contracts, taxonomy,
  decisions, runbooks. Carries `code_refs` and a CI drift guard, which is what
  facts need and procedures do not.

The domain skills (`grading-engine`, `migrations`, `tenant-isolation`,
`durable-jobs`) still own their procedures and their triggers still apply. Load
them exactly as before; this skill does not replace them.

## Writing: the same-commit rule

**If your work invalidates a note, update the note in the same commit.** This
mirrors the US-1108 migration triple. A note fixed "later" is a note fixed never,
and a confidently wrong note is worse than no note.

Before adding a note, read `vault/CONTRACT.md` — it is the only definition of the
frontmatter schema and the folder scheme.

Three rules people get wrong:

1. **Never duplicate a fact across notes.** Link to the note that owns it. Two
   copies of a number is how this repo ended up with two 363-line env references
   that nobody could tell apart.
2. **`source_of_truth: code` requires `code_refs`,** and those refs are what the
   drift guard watches. A note describing code without them is invisible to CI.
3. **Bumping `reviewed` asserts you re-read the `code_refs`.** Doing it to
   silence CI is the one failure mode no automation here can catch.

After editing, run `npm run vault:index` (regenerates INDEX.md) and
`npm run vault:lint`. Both run in CI via the `vault` verify lane, so a broken
link, an orphan, or a stale index fails the build rather than rotting quietly.
