---
title: Backlog priority contract
type: contract
status: current
source_of_truth: vault
code_refs:
  - scripts/lib/prd-priority.mjs
  - scripts/ralph/run-sdk.mjs
  - scripts/prd-lint.mjs
reviewed: 2026-07-31
tags: [prd, backlog, ralph, ordering]
summary: prd.json priority sorts ASCENDING — lowest number first — and a missing priority means unranked, so it sorts last.
---

# Backlog priority contract

Established by US-2371, decided by the operator on 2026-07-31.

## The rule

1. **Ascending. Lowest number first.** `-98701` outranks `58`, which outranks
   `2544`. "Highest priority" in any comment or docstring means the *smallest*
   number, and code that reads it literally is the bug this note exists to stop.
2. **`priority` is optional.** A story without one is **unranked** and sorts
   **last**. It is not urgent, and it is not zero.
3. **If present, it must be a finite number.** `prd-lint` fails an open story
   with a string, a `null`, a `NaN`, an `Infinity`, or an object there.
4. **Ties break on the numeric id, ascending,** so the same backlog always
   yields the same next story.

The one implementation is `comparePriority` in `scripts/lib/prd-priority.mjs`.
Import it. Do not hand-roll the subtraction — that is exactly how the two
directions came to coexist.

## Why it was broken

The backlog encoded both directions at once.

`scripts/ralph/run-sdk.mjs` sorted **descending** — `(b.priority ?? -Infinity) -
(a.priority ?? -Infinity)` — so the biggest number won and the next pick was
US-2204 at 2544. But the whole Android block was authored at `-98701` (the
US-1299 epic) down through `-98603`, ascending *within itself* in the exact
order the stories were actually worked, and US-1299's own note calls it `[P1]`.
Those magnitudes only make sense for an ascending picker. Under the descending
sort that ran in production, the Android epic could never be selected at all;
under ascending, nothing with a positive number ever could.

Both readings were defensible from the data, which is the definition of a
contract that was never written down.

## The second defect, and why it is the nastier one

96 of 247 open stories carry **no `priority` field at all**. A naive ascending
comparator does `undefined - 5`, which is `NaN`. A comparator that returns `NaN`
does not fail loudly — V8's TimSort simply produces an arbitrary, unstable
order. It is the shape described in [[guards-that-cannot-fail]]: not a check
that breaks, a check that keeps answering with the wrong answer.

This was observed, not theorised. It silently dropped US-2368 out of a top-8
listing during the session that filed US-2371.

Backfilling 96 invented numbers would have been worse than admitting those
stories are unranked, so rule 2 says so out loud and `priorityRank` maps the
absence to `+Infinity` rather than letting arithmetic produce `NaN`.

## Consumers

| File | Role |
|---|---|
| `scripts/lib/prd-priority.mjs` | The definition: `comparePriority`, `priorityRank`, `isValidPriority`, `UNRANKED` |
| `scripts/ralph/run-sdk.mjs` | `selectStory` sorts eligible open stories with `comparePriority` |
| `scripts/prd-lint.mjs` | Fails an open story whose `priority` is present and non-numeric |

Anything new that orders the backlog imports from the first row. Adding a fourth
consumer with its own comparator re-opens US-2371.

Related: [[ralph-learnings]] for the loop's other recurring gotchas.
