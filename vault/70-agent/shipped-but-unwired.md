---
title: Shipped but unwired — modules whose green tests prove nothing
type: learning
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/authenticity-eval.ts
  - services/edge-functions/src/lib/title-sync.ts
  - services/edge-functions/src/lib/grade-badge.ts
reviewed: 2026-07-19
tags: [quality, testing, dead-code, gotcha]
summary: Three modules pass their tests while nothing calls them; two are accidents that leave a stated guarantee unenforced, one is a deliberate policy retirement.
---

# Shipped but unwired

A module with a passing test suite and **no callers** is the most convincing
kind of absent feature. The tests are real, the code is correct, and the thing
the code was written to do does not happen.

This is the same defect class as [[guards-that-cannot-fail]] — a check that runs
and measures something adjacent to what it claims to protect. Here the check
runs and measures a function nobody invokes.

Verified by call-graph search on 2026-07-19.

## Accidentally dead

### `authenticity-eval.ts` — the prompt gate that does not gate

**All six exports have zero non-self callers.** `runAuthenticityEval`,
`aggregateAuthenticityEval`, `isDangerousMiss`, `caseAgrees`, `verdictToLabel`,
`authenticityEvalMinAgreement` — nothing imports any of them.

The module's own header states it plainly:

> "what is missing is the gate that would stop a bad PROMPT VERSION shipping."
> "Do not read this module's green tests as evidence the gate exists."

**Why this one matters more than it looks.** The `grading-engine` skill documents
a prompt-version lifecycle — shadow, then eval gate, then canary. That lifecycle
is real for *grading* prompts. For **authenticity** prompts the eval gate is this
module, and it is not wired, so an authenticity prompt version can ship without
clearing any accuracy bar. Anyone reading the skill would reasonably assume
otherwise.

Tracked in US-1996.

### `title-sync.ts` (edge) — the mirror that never runs

The edge copy's only consumer is `src/tests/title-sync_test.ts`. Its web
counterpart (`src/lib/title-sync.ts`) *is* wired, into the item canvas.

US-1891 required backwards title substitution on **both** the edge item-update
path and the web canvas. Only the web half landed, so, in the header's words:

> "an item field edit that does NOT go through the web item canvas (the edge
> item-update API, iOS, AutoLister, bulk edit, CSV import) still corrects the
> brand while leaving the OLD brand in `listing_title` — which is precisely the
> bug US-1891 exists to fix, on every surface except one."

A user changing a brand on iOS gets a corrected item and a stale listing title.

## Deliberately dead — do not "fix" this one

### `grade-badge.ts` — retired by marketplace policy

Removed from the publish path in `8e1802a6` as an **eBay policy decision, not
neglect**:

> "third-party-grading marks burned onto listing photos are the thing the policy
> objects to. The grade authority signal is now TEXT ONLY, via
> `applyGradeListingPromotion` (`routes/flipdesk-ebay.ts`), which writes it into
> the DESCRIPTION and never touches the imagery."

The compositor still exists and still passes its tests. Re-wiring it would
recreate the policy violation. If you notice this module and think it regressed,
it did not — this note is the answer.

## The habit this argues for

Before trusting that a module does its job, **check that something calls it**.
A passing test proves the function is correct, not that the system uses it —
and the two are routinely confused, including by the people who wrote both.


## Appendix — the US-2060 header audit, recorded so it is not repeated

Fifteen `services/edge-functions/src/lib/*.ts` files carry headers over 30 lines.
Each was triaged once, on 2026-07-19, against a single question: *would someone
working in a different file need this and fail to find it?*

**PROMOTED (6)** — content moved to a note, pointer left in the header:
`coherent-cache` and `schema-version` → [[edge-runtime-invariants]] ·
`plan-gate` → [[flipdesk-plan-gating]] ·
`depop-client`, `etsy-client`, `whatnot-client` → [[marketplace-connector-contract]] ·
`authenticity-eval`, `title-sync`, `grade-badge` → this note ·
`ebay-notification-subscriptions` → [[ebay-condition-and-policies]]

**KEEP (9)** — deliberately left as comments. These are derivations, allowlists,
threshold rationales and env tables: maximally useful exactly where they are, and
dead weight anywhere else.

`listing-quality-score` (weights derived from the ranking playbook, which is
already the canonical home) · `content-sanitize` (why a tokenizer, not a regex) ·
`etsy-client` / `whatnot-client` / `depop-client` (per-marketplace config, once
the shared shape is extracted) · `forensics` (scope limits of a Deno container) ·
`schema-version` (guard mechanics; only the same-commit rule generalises, and the
migrations skill already owns it) · `cert-integrity` (sealed-field policy,
enforced and versioned in-file) · `email-render` (email-client constraints the
callers never see).

**Do not re-litigate these nine.** The audit's conclusion is that most long
headers *should* be long: a header explaining why an implementation is shaped
this way belongs against that implementation. Only knowledge with consequences
elsewhere earns a note.

## Related

- [[guards-that-cannot-fail]] — the sibling failure mode
- [[grading-scale-and-weights]] — the lifecycle authenticity prompts do not get
- [[INDEX]]
