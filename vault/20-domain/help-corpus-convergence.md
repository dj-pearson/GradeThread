---
title: Help corpus convergence
type: decision
status: current
source_of_truth: vault
code_refs:
  - scripts/migrate-support-kb-to-help.mjs
  - services/edge-functions/src/lib/support-tools.ts
  - supabase/migrations/00183_support_kb.sql
  - supabase/migrations/00602_help_center_articles.sql
reviewed: 2026-08-15
tags: [help, support, ai-assistant, content]
summary: help_articles is the single corpus; support_kb_articles is retired, its rows migrated and its revision history archived in place.
---

# Help corpus convergence (US-2594)

## The decision

**`help_articles` is the single corpus. `support_kb_articles` is retired.** The
AI Support Assistant reads `help_articles`, through the same visibility rules the
public site uses.

`support_kb_articles` (00183, US-830) got there first and is the only corpus the
assistant may answer from, but it has **no public surface at all** — nothing in
`functions/` or `src/` renders it, so it is invisible to Google, to answer
engines and to logged-out customers. `help_articles` (00602) is the superset and
owns the web surface, the search column (00603), the feedback and freshness
clock (00605) and the analytics (00606).

Keeping both is the two-copies-must-agree failure in its worst form: the
assistant quotes one wording of an answer while the public page shows another,
and nobody notices until a customer pastes a screenshot.

## Field mapping

| `support_kb_articles` | `help_articles` | Note |
|---|---|---|
| `slug` | `slug` | Unique case-insensitively across the whole corpus. A collision is a STOP, not a merge. |
| `title` | `title` | |
| `body_md` | `body_markdown` | |
| — | `body_html` | Rendered from the markdown by the migration script, not by SQL. |
| `category` | `category_key` | See below. |
| `audience` | `visibility` | `public` → `public`, `subscriber` → `members`. |
| `is_published` | `status` | `true` → `published`, `false` → `draft`. |
| `version` | — | Not carried. `help_articles` has no version column; the history stays where it is (below). |

### Category map

Nine source categories onto the fourteen help categories:

| From | To |
|---|---|
| `grading` | `grading` |
| `flipdesk` | `flipdesk` |
| `billing` | `billing` |
| `account` | `account` |
| `getting_started` | `getting-started` |
| `pricing` | `billing` |
| `plans` | `billing` |
| `photos` | `grading` |
| `disputes` | `troubleshooting` |

The first five are exact. `pricing` and `plans` both land on `billing` because
the help taxonomy does not split them and inventing two new categories for a
handful of migrated rows would leave the sidebar lopsided.

> [!warning] Two of these are judgement, not derivation
> **`photos`** → `grading`, on the reading that the support KB's photo articles
> are about *submission* photos. If they turn out to be listing photography they
> belong in `flipdesk`. **`disputes`** → `troubleshooting`, on the reading that a
> dispute is a something-went-wrong path; if they are grade appeals specifically,
> `grading` is better. Both are one-line changes in the map and the script
> reports its per-category counts, so check the counts before applying rather
> than after.

## Revision history: archived in place

`support_kb_revisions` is **kept, not migrated and not dropped.** `help_articles`
has no revision mechanism to migrate *into*, so a migration would mean inventing
one to hold history for a corpus that no longer receives edits. The table stays
readable, the trigger that writes it stops mattering once the editor is retired,
and the history remains queryable by slug.

Dropping it was the other option and is refused: edit history is the record of
who changed a customer-facing answer and when, and this repo's rule is that a
record of an action is not the actor's to erase.

## Ordering — this is the part that breaks production

The data must land **before** retrieval is repointed. Repointing first leaves the
assistant reading an empty corpus, and its designed behaviour on an empty result
is to say it does not know and offer a human — so the failure is quiet, polite,
and total.

1. Run `node scripts/migrate-support-kb-to-help.mjs` (dry run by default) and
   read the counts.
2. Re-run with `--apply`.
3. Only then ship the retrieval change (`support-tools.ts`, `agent-tools.ts`).
4. Retire `/admin/support/kb` — one editor, not two.

## The rule that outlives this migration

The assistant must never quote a `members` or `internal` article to an anonymous
asker. Its retrieval passes the asker through the same visibility filter as every
other read, and a test asserts it cannot return an article the asker could not
have read on the public site. `internal` is the sharper half: it did not exist in
the old two-value model, and it holds operator runbooks.

Related: [[help-center-map]] for what exists and what is written,
[[service-role-tables]] for why the assistant reads through a filter rather than
through RLS.
