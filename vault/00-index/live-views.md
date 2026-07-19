---
title: Live views (Dataview)
aliases: [dataview, queries, live queries]
type: moc
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [meta, moc, dataview]
summary: Queries that compute themselves in Obsidian — the human counterpart to the generated INDEX, never a replacement for it.
---

# Live views

> [!important] These are for HUMANS in Obsidian. Agents cannot run them.
> A Dataview block is inert text to anything reading raw markdown — `Grep` sees
> the query, not its results. So these views are **added alongside**
> [[INDEX]], never instead of it, and `scripts/vault-index.mjs` stays.
> See [[adr-0003-dual-consumer-vault]] for why that is a rule and not a habit.

Requires the **Dataview** community plugin (declared in
`.obsidian/community-plugins.json`).

> [!warning] These queries are UNVERIFIED — they have never been executed
> They were written in a terminal, where Dataview cannot run. The syntax is
> conventional but unchecked, and a wrong field name or clause fails silently as
> an inline error block in Obsidian rather than anything CI can catch.
>
> **First person to open this vault in Obsidian: check each query renders a
> table rather than an error, and fix or delete the ones that do not.** Reporting
> them as working would be a claim I have no basis for.

## Every contract note

The notes CI treats most strictly — drift on these is an error, not a warning.

```dataview
TABLE source_of_truth AS "authority", reviewed AS "last verified", length(code_refs) AS "refs"
FROM "vault"
WHERE type = "contract" AND status = "current"
SORT reviewed ASC
```

## Review queue — oldest first

The same ordering the review cadence works through (US-2067 turns this into a note). Oldest at the top is the
point: a note nobody has re-read in months is the one most likely to be wrong.

```dataview
TABLE type, reviewed AS "last verified", source_of_truth
FROM "vault"
WHERE status = "current" AND source_of_truth = "code"
SORT reviewed ASC
LIMIT 15
```

## Decisions due a re-argument

`revisit_by` in the past while status is still `accepted` — a decision that
expired without anyone noticing.

```dataview
TABLE revisit_by AS "revisit by", status
FROM "vault/60-decisions"
WHERE revisit_by
SORT revisit_by ASC
```

## Notes with no code_refs

Fine for `source_of_truth: vault`. On a `code` note it means the drift guard has
nothing to watch, which `vault-lint` already rejects — this view is how you spot
one before CI does.

```dataview
TABLE source_of_truth, type
FROM "vault"
WHERE source_of_truth = "code" AND (!code_refs OR length(code_refs) = 0)
```

## By area

```dataview
TABLE length(rows) AS notes
FROM "vault"
WHERE type != "moc"
GROUP BY split(file.folder, "/")[1] AS Area
SORT Area ASC
```

## Archive — excluded from normal navigation

```dataview
LIST summary
FROM "vault/90-archive"
SORT file.name ASC
```

## Related

- [[INDEX]] — the generated index agents read
- [[adr-0003-dual-consumer-vault]] — why both exist
- [[CONTRACT]] — the frontmatter these queries read
