---
title: The weighted-overall lockstep — two implementations, not four
aliases: [rounding sites, rounding lockstep, roundToTenth]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/weighted-grade.ts
  - services/edge-functions/src/lib/human-review.ts
  - services/edge-functions/src/lib/ai-grading.ts
  - src/test/fixtures/weighted-grade-cases.json
  - src/lib/rubrics.ts
  - services/edge-functions/src/lib/rubric.ts
reviewed: 2026-09-23
tags: [grading, rounding, lockstep, contract]
summary: One client helper and one edge helper compute the weighted overall; they must agree exactly, and the formula has shipped wrong twice when copies drifted.
---

> [!note] Re-reviewed 2026-09-11 (US-3329). The only change to this note's code refs since its last review renames the fifth grading factor's LABEL from "Odor & Cleanliness" to "Cleanliness" (and in ai-grading.ts adds the flag-gated GRADING_CLEANLINESS_V2 wording). Checked: nothing this note states depends on that label, the factor key, or its weight.

# The weighted-overall lockstep

Every surface that shows or stores a weighted overall computes:

```
overall = round_half_up(Σ factor × weight, 1 decimal)   clamped to 1.0 … 10.0
weights: fabric .30 · structural .25 · cosmetic .20 · functional .15 · odor .10
```

The sum and the rounding are done in **integers**, not floats (see
[Midpoints round half up](#midpoints-round-half-up-integer-arithmetic) below).

**The number an operator sees while adjusting factor scores must be the number
the server persists to the certificate.** Grade tier is a pricing-band input and
the resealed certificate hash makes the stored value look authoritative, so a
mismatch is money, not cosmetics.

## The current architecture — read this before editing anything

There are **two** implementations, not a scatter of copies:

| Side | Implementation | Consumers |
|---|---|---|
| **Client** | `src/lib/weighted-grade.ts` → `computeWeightedOverall` (US-2034) | `admin/grading.tsx` (the Review Queue) and `admin/disputes.tsx`, both importing it |
| **Edge** | `services/edge-functions/src/lib/human-review.ts` → `computeWeightedOverall` | `grade-adjustment.ts`, `routes/admin-disputes.ts`, `routes/admin-grading.ts` |

Plus `ai-grading.ts`, which does the original composite parse through
`computeAiWeightedOverall` (formerly a private `roundToTenth`), the score the AI
report ships with before any human touches it. It rounds through human-review's
`roundWeightedToTenth`.

**Adding a new surface? Import one of the two. Do not write a third.**

> **There used to be a third client consumer.** `admin/reviews.tsx` was deleted
> on 2026-08-14 (US-2505): `/admin/reviews` and `/admin/grading` were two UIs
> over the same data, two operators could finalize the same report from them, and
> the Review Queue in `admin/grading.tsx` is the superset that survived. The
> lockstep did not change, only the count of pages holding it.

### The weight table in `ai-grading.ts` (US-2306)

`ai-grading.ts` also carries its own `FACTOR_WEIGHTS`, and until 2026-08-02
nothing could pin it: the table was module-private, and the file's own
"keep **this** in lockstep" comment did not match the drift-guard's marker
pattern, so it was absent from the registry as well. Correct by inspection,
guarded by nothing.

It is **not** a redundant copy that could be imported away, and that is the part
worth knowing before anyone tries:

- `human-review.ts` keys its weights by the **DB column** names
  (`fabric_condition_score`, …) — the shape a *stored* grade has.
- `ai-grading.ts` keys its weights by the **AI response field** names
  (`fabric_condition`, …) — the shape the *model returns*.

Same five numbers, two key spaces. So it is a translation, not duplication, and
collapsing them means giving one side the other's key names.

The table is now exported and pinned instead: `weighted-grade-parity_test.ts`
asserts the two tables agree factor for factor through that key map, and a
companion case fails if a sixth factor appears on either side — otherwise the
comparison would pass by iterating a map that no longer covers both.

### What an INCOMPLETE factor set does (US-2386)

Both implementations **refuse**: `requireFactor` throws when a factor is
missing, `null`, `undefined`, `NaN` or not a number. Neither returns a value.

They did not always agree, and the disagreement was invisible because the
shared fixture had no case for it. The client coalesced with `?? 0`; the edge
had no coalesce, so the arithmetic fell out as `NaN`. Of the three possible
behaviours, **coalescing is the dangerous one**, and the reason is the weights:

> Fabric alone is 30% of the blend. Score a missing fabric factor 0 and a
> genuine 8.4 becomes about 5.4 — a plausible "Fair" grade, not an obvious
> error. Nothing looks broken, so nothing gets checked. The operator accepts
> it, the reseal recomputes the certificate's tamper-evident hash against it,
> and the wrong number is then served to buyers as *verified*.

`NaN` is bad but loud. Refusing is loud at the point of the bug.

This is **not** defensive coding against a data condition. All five factor
columns are `NOT NULL` on `grade_reports` (00001) and every caller builds the
object from a complete row, so a missing key can only be a programming error —
which is exactly why refusing costs nothing and silence costs a certificate.

The fixture now carries `refusal_cases` alongside `cases`, asserted by both
suites. Two encoding caveats live with it, because a fixture that misrepresents
its own inputs is worse than none: JSON cannot express `undefined` (the key is
dropped on write, so that case is indistinguishable from an omitted one) and
cannot express `NaN` (carried as the sentinel `"__NaN__"`, which each runner
must translate — and both suites assert that they did, since a runner that
forgot would still see a throw and pass for the wrong reason).

Related: the admin pages no longer re-declare `FactorScores` locally and
no longer cast into `WeightedFactorScores`. The cast was harmless only while the
shapes happened to match; it would have swallowed a dropped or renamed key
silently, which is the compile-time half of this same defect.

## Midpoints round half up (integer arithmetic)

Both helpers, and everything that delegates to them, round through one function
per project: `roundWeightedToTenth` in `src/lib/weighted-grade.ts` (web) and in
`services/edge-functions/src/lib/human-review.ts` (edge). It takes each score in
hundredths of a point and each weight in basis points, so every product and the
sum are exact integers, then rounds half up on that integer. One tenth is
100,000 units.

**Why integers and not an epsilon nudge.** Until grading-plan action 1 every
site computed `Math.round(floatSum * 10) / 10`. A float sum of .30/.25/.20/.15/.10
products cannot hold an exact .x5 midpoint, so it lands a hair low or a hair
high more or less at random. Measured over all 19^5 = 2,476,099 half-step factor
sets: **72,858** were wrong, every one a midpoint that rounded DOWN. With every
factor in 6.0-10.0 it was 2,011 of 59,049, and five of those crossed the 8.0
tier line: 9/6/8/9/8 is exactly 7.95 and was stored as 7.9 Very Good instead of
8.0 Excellent. An epsilon added before `Math.round` fixes the half-step inputs
but is a tolerance someone has to reason about for every new weight table;
integer units make the midpoint decision exact by construction, and the rubric
weights (all whole percents) fit them with room to spare.

Every copy agreed with every other, which is why the lockstep fixture stayed
green through all of it: **agreement is not correctness.** So the fixture now
carries three midpoint cases (9/6/8/9/8 -> 8.0, 5/5/5/9/5.5 -> 5.7, and
6/6/6/6/6.5 -> 6.1, a midpoint the float already rounded up and must keep), and
each project runs an exhaustive check of every half-step set against an integer
reference: `src/lib/__tests__/weighted-grade-midpoint.test.ts` and
`services/edge-functions/src/tests/weighted-grade-midpoint_test.ts`.

What runs through the helper:

- Edge: `human-review.computeWeightedOverall`, `ai-grading.computeAiWeightedOverall`
  (was the private `roundToTenth`), `rubric.computeRubricWeightedOverall`.
- Web: `computeWeightedOverall`, `rubrics.computeRubricWeightedOverall`, the
  certificate's `ScoreExplainer` and `example-account.exampleWeightedScore`.
- iOS and Android compute no overall; both render the stored `overall_score`.

**Already-issued grades are unchanged.** The fix affects new grades and new
human adjustments only. A stored overall that was rounded down at a midpoint
stays as stored, and so does its certificate hash, until the owner decides
whether to reseal those rows through the human-review reseal path. That
decision is open.

## Why this note exists: it has shipped wrong twice

- **US-1557** fixed a divergent copy in `admin/grading.tsx`.
- **US-2041** found the same bug still live in `admin/disputes.tsx`, rounding to
  the nearest **0.5** while every other site rounded to **0.1**. An operator
  adjusting a dispute saw an overall up to **0.2 away** from what was persisted,
  in both directions — 8.5 shown vs 8.3 stored, and 8.5 shown vs 8.7 stored.

US-2034 then consolidated the three admin UIs of the day behind one helper, which
is why the client column above has a single entry. That consolidation is the fix;
the per-file copies are gone. One of those three pages has since been retired
(see the note under the table), leaving two importers of the same helper.

## Why 0.1 overall and 0.5 factors

Factors move in half-points because they are human-scale judgements. The overall
rounds to a tenth so that a single-factor correction stays visible: fabric
7.0 → 6.5 at 30% weight moves the overall by 0.15 — visible at 0.1 rounding,
**invisible at 0.5**. That is precisely the drift US-2041 hid.

## Related

- [[grading-scale-and-weights]] — the scale and factor weights this computes over
- [[guards-that-cannot-fail]] — why "reviewers will catch it" was not a control
- [[INDEX]]
