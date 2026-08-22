---
title: Shipped but unwired — modules whose green tests prove nothing
type: learning
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/authenticity-eval.ts
  - services/edge-functions/src/lib/title-sync.ts
  - services/edge-functions/src/lib/reconcile-fields.ts
  - services/edge-functions/src/lib/rubric.ts
  - src/test/no-dead-column-writes.test.ts
  - src/components/waitlist-form.tsx
  - src/test/waitlist-capture-reachable.test.ts
  - scripts/audit-unwired-exports.mjs
  - scripts/check-unwired-modules.mjs
  - scripts/check-web-unwired.mjs
reviewed: 2026-08-22
tags: [quality, testing, dead-code, gotcha]
summary: Modules that pass their tests while nothing calls them; one was a real unenforced guarantee now half-wired, one was ruled uncalled-by-design and that ruling turned out to be wrong, one was a policy retirement that got deleted once a live switch started promising it, one was assumed correct because being unwired hid a broken table, and one was a UI component whose absence left a lockout switch armed — telling the shapes apart is the point.
---

# Shipped but unwired

A module with a passing test suite and **no callers** is the most convincing
kind of absent feature. The tests are real, the code is correct, and the thing
the code was written to do does not happen.

This is the same defect class as [[guards-that-cannot-fail]] — a check that runs
and measures something adjacent to what it claims to protect. Here the check
runs and measures a function nobody invokes.

Verified by call-graph search on 2026-07-19, re-verified 2026-08-08. Two of the
four verdicts had gone stale in three weeks, which is roughly the point of the
note.

## Accidentally dead

### `authenticity-eval.ts` — the prompt gate that did not gate (partly fixed)

**Was:** all six exports had zero non-self callers. `runAuthenticityEval`,
`aggregateAuthenticityEval`, `isDangerousMiss`, `caseAgrees`, `verdictToLabel`,
`authenticityEvalMinAgreement` — nothing imported any of them, while the
`grading-engine` skill documented a shadow → eval gate → canary lifecycle that
was real for *grading* prompts and vacuous for *authenticity* ones.

**Now (US-1996):** three exports are wired, and the distinction matters.

- `warnAuthenticityGate` runs at boot in `main.ts`, so a live authenticity prompt
  with no passing eval run announces itself instead of being silent.
- `assertAuthenticityPromptActivatable` fails closed and exists so a future
  activation path cannot be built without it.
- `authenticityGateStatus` backs both, and treats a query error, a missing run
  and a model mismatch all as **ungated**.

**Still not enforced, deliberately:** nothing BLOCKS, because authenticity
prompts are code constants rather than `ai_prompt_versions` rows — there is no
activation call to intercept. Wiring a blocker today would mean inventing a
lifecycle nobody asked for, which is how the dead code appeared in the first
place. `authenticity-gate-guard_test.ts` fails the build if an activation path
ever appears without calling the eval. `grading_eval_cases` also has no
authenticity rows yet (US-2131 — expert-dependent, cannot be generated), so the
boot warning reports ungated for every version until real labeled cases exist.

## Three modules have since graduated, which is the thesis holding

The allowlist in `scripts/check-unwired-modules.mjs` is down to four entries:
`drip-trigger.ts`, `rubric.ts`, `brand-seed.ts`, `content-ai-email.ts`. Three
names left it between 2026-08-15 and 2026-08-20, and each left the same way —
the codebase changed around a verdict that had been correct when written:

- **`grading-reliability.ts`** (2026-08-15, US-2035). The env-gated job that
  feeds it live re-grades now exists as `routes/jobs-grading-self-consistency.ts`,
  so the module has a caller.
- **`size-systems.ts`** (2026-08-17, US-2215). Its entry said a converted size
  would have to go through the trusted block first. It now does:
  `usEquivalentForLabel` is called from `grading-size.ts`'s
  `sizeVerificationLine`.
- **`marketplace-observations.ts`** (2026-08-20). The entry's own closing line
  said to remove it when a route imports it. `routes/flipdesk-sync.ts` imports
  `planObservations` and `planSaleEffects`, and **the gate had been failing since
  that route landed** — the allowlist doing exactly what it is for.

Each was left in the script as a COMMENT rather than deleted, so the next reader
sees a module that graduated instead of a name that quietly vanished. That is
worth copying: a silently shrinking allowlist and a correctly shrinking one look
identical in a diff nobody reads.

## Judged "uncalled by design" — and judged wrong

The section below used to be the counterweight to the one above: proof that zero
callers can be the correct state. Its single example turned out to be
accidentally dead after all, which makes it a better lesson than it was an
example. **A "by design" verdict is a claim about the rest of the codebase, and
it decays.** Re-check it before you rely on it, especially when it rests on
something not existing.

### `title-sync.ts` (edge) — WIRED as of 2026-08-08 (US-1995)

> [!warning] This entry said "uncalled by design" for three weeks, and it was wrong
> It argued the edge copy should keep zero callers, on the grounds that **no
> route in `services/edge-functions` does `.update()` on `inventory_items`**.
> That claim was false: `reconcile/apply` in `flipdesk-autolister.ts` writes both
> `inventory_items` and `listings` from `buildMergeWrites`. The same entry listed
> "web item canvas | wired", naming a file that had already been deleted — its
> replacement, `composer.tsx`, inherited none of the sync. A confident
> do-not-touch entry was standing guard over two live gaps.

**Why it read as settled.** The 2026-07-19 audit was per-surface and genuinely
careful; what it got wrong was arguing from an **absence**. "No route does X"
cannot fail a test, so nothing announced it when a route started doing X. Where a
claim like that is load-bearing, pin it with a test rather than a paragraph.

Every surface that writes a syncable title field, re-audited 2026-08-08:

| Surface | State |
|---|---|
| web composer | wired (`buildTitleSyncPatch`) — was the P1 gap |
| web bulk edit | wired (`buildTitleSyncPatch`) |
| web grid inline edit | wired (`buildTitleSyncPatch`) |
| edge `reconcile/apply` | wired via `reconcile-fields.ts` — the kept title is reconciled against the winning brand/size/color/style; pinned by `reconcile-fields_test.ts` |
| AutoLister generate | N/A — regenerates titles wholesale |
| identification-verify | N/A — writes only `attributes` / `ai_field_sources` |
| CSV import | N/A — fill-only, so the old value is blank and the substitution is a provable no-op |
| **iOS** | **the one remaining gap** — and it cannot consume this module; it needs a Swift port (`AIItemFieldWriter`) |

The module is still one half of the behavioural parity fixture
(`src/test/fixtures/title-sync-cases.json`) asserted by both the deno and vitest
suites, which is what keeps the two copies honest.

A user changing a brand on **iOS** still gets a corrected item and a stale
listing title. That is the whole of what remains of US-1995, and it needs a
macOS session — see [[blocked-work-gates]].

## The unwired thing that was a LOADED SWITCH (US-2449, 2026-08-11)

Every entry above is a module whose absence made something silently *not
happen*. `src/components/waitlist-form.tsx` was the other shape: an orphan whose
absence armed a **lockout**.

The staged-launch waitlist shipped complete except for its front door. The
anonymous capture route (`routes/waitlist.ts`), the per-account gate
(`lib/access-gate.ts`), the operator queue at `/admin/waitlist` with its nav
entry, the pending page, the `edge-fetch` 403 branch — all live, all correct,
all reachable from one `feature_flags` row, `waitlist_gating`. `WaitlistForm`
had **zero importers**, and the only other mention of it anywhere in the repo
was a *comment* in `newsletter-signup.tsx` saying it mirrored the same
prerender-safe dynamic-import pattern.

So flipping one boolean would have gated every non-staff account, while the only
public way to create the approved row that ungates you rendered nowhere.

**Two things about it are worth carrying forward.**

First, **a caller-less UI component is harder to see than a caller-less
module.** The audit tool that found the rest of this note,
`scripts/audit-unwired-exports.mjs`, works the import graph — which is right,
and which US-1995 already learned the hard way. But a component's *danger* is
not proportional to its own deadness; it is proportional to what its absence
leaves armed. Nothing ranked this one, because nothing knew the switch existed.

Second, **the operator-facing half is the half that hides.** With the gate on
and no capture path, an operator opens `/admin/waitlist` and sees a queue that
can only ever shrink. An empty queue during a staged launch looks exactly like a
quiet week. There is no error, no alert, and no way to tell "nobody applied"
from "nobody *can*".

Also true and separately missed: **signup never wrote a `waitlist_entries` row**
— nothing did except the form. So a person who signed up while the gate was
closed was shown a page saying "you're in the queue" while the queue had no
record of them. The page's claim was false and the operator had no way to find
out. `waitlist-pending.tsx` now enrols the signed-in account itself.

**The remedy is the invariant, not the wiring.**
`src/test/waitlist-capture-reachable.test.ts` asserts what nobody had written
down: *if the flag can be turned on, a public way in must exist.* It discovers
importers from source with comments stripped (a naive grep reads that
`newsletter-signup.tsx` comment as a caller, which is precisely how this
survived), and it fails a **half-retirement** too — deleting the form while
leaving the flag armed is the failure mode US-2449's own AC2 was written
against. The form is gated on `useWaitlistGating()` so it renders only while the
gate is genuinely closed, which keeps US-1949's finding intact: a "join the
waitlist" button beside a live "Start Grading Free" is a vaporware signal, and
was rightly removed. A waitlist shown only when the door is actually shut is a
different, true claim.

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

### `rubric.ts` — PENDING, and "pending" hid a broken table

Self-documents as "FOUNDATION ONLY: this registry is NOT yet wired into the live
pipeline, so clothing grading is byte-for-byte unchanged." Covered by the open
**US-1997** (category rubric activation), whose decision the owner settled on
2026-07-23: **ACTIVATE**, as a multi-phase program.

The 2026-07-19 triage closed this entry with "nothing to do; the header and the
story already agree." That was true about the *wiring* and wrong about the
*content*, which is the correction worth keeping (2026-08-07):

Each non-clothing rubric carried a `defectRouting` table keyed on invented
defect names — `corner_ding`, `edge_whitening`, `surface_scratch`, `off_center`,
`crease`, `scratch`, `crack`. None of the seven is a member of the shared
`DefectType` taxonomy in `defect-weighting.ts`, and `coerceDefectType` folds any
unrecognized string to `other`. So every one of those routings was unreachable
from the moment it was written: a sports card's corner ding would have arrived
as `other` and debited `surface` via the first-factor fallback, never `corners`.
The clothing entry had the milder version of the same problem — a three-entry
hand-copy of a sixteen-entry live table, so the other thirteen clothing defect
types also fell through to the fallback.

**The generalisable bit, and it sharpens this note's thesis.** Being unwired is
what let the table look fine. Nothing called it, so nothing could have produced
a wrong answer from it, so no test had a reason to check its keys against the
taxonomy they were declared to come from. "Correct-but-not-yet-connected" was
assumed when only "not-yet-connected" had been verified. A scaffold accumulates
defects at exactly the rate a live module would, and reports none of them.

Fixed under US-1997: the routing type is now `Partial<Record<DefectType, …>>`
so the compiler rejects an invented key, clothing REFERENCES the live
`FACTOR_ROUTING` export rather than copying part of it, the documented
"unmapped defects fall back to the first factor" rule is implemented
(`routeDefectToRubricFactors` — it had been a comment and nothing else), and
`rubric-parity_test.ts` asserts every routing key survives `coerceDefectType`
and every split sums to 1.0 over its own rubric's factors. The card/watch
vocabulary with no honest taxonomy equivalent was **not** faked; extending
`DefectType` is a prompt change (the vision model is given the enum), so it
goes through the eval gate in Phase 2.

**2026-08-09 — a fifth rubric, and a second way to be dead.** US-2225 added
a `bags` rubric and it shipped keyed `handbags`. The `item_category` enum
(00230) spells it `bags`, and `rubricForKey()` is called with an item_category,
so that rubric could never have been selected — every handbag would have kept
grading as clothing, which is the exact bug the story existed to fix,
reintroduced by the fix. Nothing failed: the rubric existed, the parity fixture
passed, the certificate rendered clothing factors.

That is a DIFFERENT deadness from the one this page catalogues. The
import-graph audit finds modules nothing imports; this module IS imported, and
the dead thing was a KEY inside a lookup table. No import graph can see that.
The guard is now `rubric-parity_test.ts`: every key in `RUBRICS` must exist in
`PHOTO_PROFILES`, whose keys ARE the item_category vocabulary. Generalisable —
when reachability depends on a string matching a value declared somewhere else,
pin the two together, because both halves look correct in isolation.

Still unwired into the pipeline, still correct that it is. See
[[blocked-work-gates]] for what Phase 2 is actually waiting on.

**2026-08-22 — a third way to be dead: nothing can SAY the key.** US-2223 added
a `headwear` rubric, a headwear photo profile and a headwear measurement
template, and migration 00570 added `headwear` to the `item_category` enum,
applied to production on 2026-08-09. Every one of those keys matched. The
rubric still never ran, for two weeks, and a cap kept grading as an accessory.

`rubric-parity_test.ts` — the guard written for the `handbags` case above — was
green throughout, correctly. It pins `RUBRICS` keys to `PHOTO_PROFILES` keys,
and both said `headwear`. What it cannot see is whether anything upstream is
able to EMIT that value. Four hand-written copies of the category list had never
learned it, and the load-bearing one is `ai-extract.ts`, which interpolates its
copy into the extraction prompt AND uses it as the model's JSON-schema enum. A
missing value there is not a rejected answer; it is an answer the model was
never permitted to give. The prompt also instructed, in prose, that a hat is
`accessories`.

So the chain has three links, not two: something must PRODUCE the key, a lookup
must CONTAIN it, and the thing it selects must EXIST. The `handbags` case broke
link two and was pinned. This broke link one, which nothing was watching.

The generalisation above still holds and needed widening: pin the PRODUCERS of
a vocabulary to it as well as its consumers. `garment-taxonomy-copies.test.ts`
now holds `ITEM_CATEGORIES` across every copy that keeps one, asserts the
extraction prompt does not name the wrong category in words, and asserts every
value has a `PHOTO_PROFILES` entry — reading the registry KEYS rather than the
file text, because a whole-file match is satisfied by the comments explaining
the bug.

Two enum dimensions widened in the SAME migration and only one got a guard, so
the other went stale in silence. When a migration touches more than one
vocabulary, check each separately: the story that fixes one will describe
itself as fixing "the" taxonomy drift.

**2026-08-22 — a fourth way: the flag is ON and the feature still cannot run.**
The three above are about a thing nothing reaches. This one is reached, and
returns early every time, because what it READS has no value for the input in
front of it. It cost the owner a config change on my advice, twice in one day.

`GRADING_SIZE_VERIFY` was set on to feed the 41 curated footwear sizing charts
into shoe grades. It cannot: the gate is `sizeVerifyGradingEnabled() &&
hasMeasurementPhotos`, and `isMeasurementPhoto` wants a type starting
`measurement` or equal to `flatlay`. The grading `image_type` enum holds five
measurement values — chest, waist, length, sleeve, inseam — every one a
garment tape measurement, and no `flatlay` at all (that belongs to
`flipdesk_photo_type`, a different enum). A shoe cannot satisfy the second
condition, and `ai-size-estimate.ts` agrees from the other end with zero
mentions of shoe, footwear or insole.

The redirect to `GRADING_TAG_OCR` was better and still one link short. It DOES
fire on `label`, which a submission requires, and its size example is
literally `EU 42` — but the prompt says "you are shown ONLY the brand/size/care
label of a single garment", the tool is `read_garment_tag`, and two of the five
fields it asks for are fiber content and an RN number, a textile registration
footwear does not carry. The gate fits; the prompt does not.

**The rule: a flag being on is not a feature being reachable.** Both times the
gate was correct and something one step further in — an enum with no value for
this input, then a prompt with no concept of it — made the feature inert.
Trace what the feature READS, not just what turns it on, and prefer one real
run as evidence over any amount of reading. US-2811 carries the footwear
chain.

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
for does not exist. Before wiring one, check that its declared callers are real.
And check the reverse too — `title-sync.ts` above was declared to have no
possible caller, and by then it had one.

## The detector was itself undetected (US-2495, 2026-08-11)

Everything above was found by `scripts/audit-unwired-exports.mjs`. That script
was executable, dated, and referenced by **nothing** — not `package.json`, not
`scripts/verify.mjs`, not a single workflow. It ran when somebody remembered it
existed, which over three weeks meant three times, and each of those three times
it found a real defect.

Its own header is why:

> This is a REPORT, not a gate. Plenty of hits are legitimate — test-only reset
> helpers, deliberate public API. Read it, don't CI-fail on it.

Every clause of that is true, and together they produced a tool nobody read. **A
report nobody is scheduled to read is indistinguishable from no report** — which
is this note's own thesis, applied to the instrument that wrote it.

`scripts/check-unwired-modules.mjs` is the fix, and it is a **wrapper rather than
a stricter mode**, because the header's objection stands: most hits are
legitimate, and a bare non-zero exit would be noise that gets muted inside a
week. What is not legitimate is a *new* one arriving unnoticed. So every
currently-dead module is allowlisted **with the verdict a human reached** —
`SUPERSEDED` / `PENDING` / `HALF-WIRED`, the three the audit's own closing line
says look identical in its output — and anything else fails, in `verify` and in
CI both (verify-only is shed by `--no-verify`; US-2402 recorded that on the UI
gate).

**A thin reason is a failed reason, and the test that says so caught me.** My
first entry for `grading-reliability.ts` read *"PENDING. Triaged 2026-07-19 and
unchanged since."* The assertion rejected it, so I read the module instead of
padding the string — and it is not PENDING at all. It is US-481's
self-consistency math, correct and tested, whose feeder job was never built; and
since US-2035 established that grading is *not* temperature-pinned on the default
model, run-to-run variance is real and this module is the only thing that could
measure it. The entry now says **allowlisted because US-2035 owns it, not because
it is fine**. A one-word verdict would have buried that.

**The gap this leaves, stated rather than scoped away.** The gate covers
`services/edge-functions/src/lib` only. The three instances that prompted it were
all on the *web* side — a React component and two hooks — and none of them would
be caught by it. Components have a guard now
(`src/test/waitlist-capture-reachable.test.ts`, US-2449); hooks have nothing, and
`useFeatureFlag` (US-2361) and `useListingCopy` (US-2442) are both sitting there
today.

> [!note] The web gap is closed at MODULE granularity (2026-08-22)
> `scripts/check-web-unwired.mjs` asks the same question of `src/`, in the verify
> web lane and in CI beside its edge twin. A module no production file imports
> fails unless it is allowlisted with a verdict, and an allowlist entry that
> stops matching fails too.
>
> **Why the audit that already sweeps `src/` could not find this.**
> `audit-file-local-exports.mjs` works one export at a time and protects a class
> it labels `imported ONLY by tests <- must NOT be un-exported` — 415 of them.
> That instruction is right; un-exporting one breaks the test and shrinks
> nothing. But it means a module whose *every* export is test-only reads as 415
> correct entries rather than as one module that does not run. The audit asks
> whether an export keyword is load-bearing. The gate asks whether the module is.
>
> First run found `src/lib/list-sort.ts` — US-1651's client-side grade sort, made
> unnecessary when US-2196 denormalised `overall_score` onto `submissions`
> (migration 00494) so the page could order server-side. Deleted with its nine
> tests. Its header still described how the submissions list sorts, which had
> not been true since 00494.
>
> **The granularity limit, so nobody reads more into a green run than is there.**
> This gate sees whole modules. A live module carrying one dead export is
> invisible to it and stays the audit's job — which currently names eight,
> including two in `video-grading-contract.ts`.

> [!note] One of the two was resolved by DELETING it (2026-08-15)
> `useFeatureFlag` is gone, with `client-experiments.ts` and its tests, on the
> owner's call. It had been re-verified as having zero callers three times over
> two weeks, which is the tell this note is about: a re-check that keeps
> returning the same answer is not diligence, it is a decision nobody is making.
> The alternative — wiring it to an experiment invented to justify the code —
> would have been worse than either keeping or removing it.
>
> `useListingCopy` is WIRED now — `src/pages/flipdesk/composer.tsx:477` calls it,
> and the sweep above confirms it, so this line saying "still there" outlived the
> thing it described by some weeks. The asymmetry it drew is still the useful
> part: unwired code is not automatically wrong, and the question is always which
> of the two things was meant to exist. One of these was deleted and one was
> wired, and both were right. See [[experimentation]] for the reasoning kept.

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
