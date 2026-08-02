---
title: Shipped but unwired — modules whose green tests prove nothing
type: learning
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/authenticity-eval.ts
  - services/edge-functions/src/lib/title-sync.ts
  - src/test/no-dead-column-writes.test.ts
reviewed: 2026-08-02
tags: [quality, testing, dead-code, gotcha]
summary: Modules that pass their tests while nothing calls them; one is a real unenforced guarantee, one is uncalled by design, one was a policy retirement that got deleted once a live switch started promising it — and telling the shapes apart is the point.
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

## Uncalled by design — the audit already ran

Zero callers, and that is the correct state. The distinction from the section
above is the whole value of this note: one of these is an unenforced guarantee,
the other is a module doing exactly what it should.

### `title-sync.ts` (edge) — uncalled by DESIGN, not by accident

> [!warning] This entry was wrong until 2026-07-19 — do not act on the old version
> It previously said the gap was "the edge item-update path". **There is no such
> endpoint** — no route in `services/edge-functions` does `.update()` on
> `inventory_items`. Anyone acting on that would have hunted for something never
> built. The per-surface audit under US-1995 settled it; neither this note nor
> the module header was updated at the time, so both kept pointing the wrong way.

The edge copy has zero production callers and **should keep them**. Every surface
that writes a syncable title field was checked individually:

| Surface | State |
|---|---|
| web item canvas | wired (`buildTitleSyncPatch`) |
| web bulk edit | wired — this was the real gap, now closed |
| AutoLister | N/A — regenerates titles wholesale |
| identification-verify | N/A — writes only `attributes` / `ai_field_sources` |
| CSV import | N/A — fill-only, so the old value is blank and the substitution is a provable no-op |
| **iOS** | **the one remaining gap** — and it cannot consume this module; it needs a Swift port |

So the module stays for two reasons: it is the reference the Swift port mirrors,
and it is one half of the behavioural parity fixture
(`src/test/fixtures/title-sync-cases.json`) asserted by both the deno and vitest
suites. Deleting it would remove one side of the only guard keeping the copies
honest.

`scripts/audit-unwired-exports.mjs` will keep reporting it as unwired. That
report is correct; this entry is the answer to it.

A user changing a brand on **iOS** still gets a corrected item and a stale
listing title. That is the whole of what remains of US-1995, and it needs a
macOS session.

## Deliberately dead — and why that was not enough

### `grade-badge.ts` — retired by policy, then DELETED (US-2382, 2026-08-02)

Removed from the publish path in `8e1802a6` as an **eBay policy decision, not
neglect**:

> "third-party-grading marks burned onto listing photos are the thing the policy
> objects to. The grade authority signal is now TEXT ONLY, via
> `applyGradeListingPromotion` (`routes/flipdesk-ebay.ts`), which writes it into
> the DESCRIPTION and never touches the imagery."

For a year the compositor sat there passing its tests, and this section said
"do not fix this one". That held until a live UI started promising it: US-2247
shipped a composer switch writing `badge_enabled` / `slab_image_mode`, having
inferred from publish's SELECT list that publish read them. It did not.

**The lesson for this note is that "deliberately dead" is not a stable state.**
A retired module with an intact API is a standing invitation, and a comment
saying "do not re-wire" only reaches someone who opens the file — not someone
who reads a SELECT list two modules away. US-2382 resolved it the durable way:
`grade-badge.ts` (both halves), `src/lib/slab-image.ts` and their tests are
**deleted**, the columns are out of publish's SELECT, and
`src/test/no-dead-column-writes.test.ts` fails if anything writes either column
again. Prefer deletion plus a guard over an annotation whenever the dead thing
has a name a feature could plausibly want. See
[[grade-authority-on-listings]] for the policy itself.


## The 2026-07-19 triage — the remaining three

`scripts/audit-unwired-exports.mjs` reports seven dead modules. Four were already
explained (above, plus `drip-trigger.ts`, superseded by the inline
`switch (journey.trigger)` in `jobs-journey-tick.ts`). These are the other three,
verified by hand — because the tool cannot tell superseded from pending from
broken, and all three shapes turned up here.

### `content-ai-email.ts` — SUPERSEDED, safe to ignore

US-918's newsletter copywriter. `newsletter-copy.ts` (US-922) carries the same
header and **is** wired — `newsletter-assembler.ts` imports
`generateNewsletterCopy` at step 2. The two have different shapes: the old one
generated *and persisted*; the replacement is pure prompt-building consumed by
the assembler. 4 exports, **0 tests**, 0 callers. Dead by supersession, like
`drip-trigger.ts`.

### `rubric.ts` — PENDING, correctly

Self-documents as "FOUNDATION ONLY: this registry is NOT yet wired into the live
pipeline, so clothing grading is byte-for-byte unchanged." Covered by the open
**US-1997** (category rubric activation). Nothing to do; the header and the story
already agree.

### `brand-seed.ts` — the gate that could never have run

The interesting one. Its header states that "the AI-assisted drafting job, the
admin verify UI, and every brand-content seed run" pass through
`validateBrandFact` / `partitionSeedFacts` so an unsourced fact is "REJECTED, not
stored". It has zero callers — **and it never could have had any**:

- Brand facts are seeded by **SQL migrations** (37 files, 178 inserts). SQL
  cannot call a TypeScript validator.
- `admin-brand-knowledge.ts` performs no writes at all.
- The schema does not enforce it either: `00389` declares `source_url text`,
  **nullable**.

So the stated guarantee rested entirely on author discipline across 37
hand-written migrations. Measured: **178 of 178** inserts list `source_url` — the
discipline held perfectly, which is precisely when installing a ratchet is free.
`services/edge-functions/src/tests/brand-fact-provenance_test.ts` now enforces it.

Why this one is worth the guard rather than just a note: `brand_knowledge`
grounds authenticity assessments, and an unsourced row does not announce itself
at read time. It reads like every other fact and makes the model *more*
confident, not less.

**The generalisable bit:** a module can be unwired because the path it was built
for does not exist. Before wiring one, check that its declared callers are real —
`title-sync.ts` above failed the same way.

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
