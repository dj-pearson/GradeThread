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
reviewed: 2026-08-02
tags: [grading, rounding, lockstep, contract]
summary: One client helper and one edge helper compute the weighted overall; they must agree exactly, and the formula has shipped wrong twice when copies drifted.
---

# The weighted-overall lockstep

Every surface that shows or stores a weighted overall computes:

```
overall = round(Σ factor × weight, 1 decimal)   clamped to 1.0 … 10.0
weights: fabric .30 · structural .25 · cosmetic .20 · functional .15 · odor .10
```

**The number an operator sees while adjusting factor scores must be the number
the server persists to the certificate.** Grade tier is a pricing-band input and
the resealed certificate hash makes the stored value look authoritative, so a
mismatch is money, not cosmetics.

## The current architecture — read this before editing anything

There are **two** implementations, not a scatter of copies:

| Side | Implementation | Consumers |
|---|---|---|
| **Client** | `src/lib/weighted-grade.ts` → `computeWeightedOverall` (US-2034) | `admin/reviews.tsx`, `admin/grading.tsx`, `admin/disputes.tsx` — all three import it |
| **Edge** | `services/edge-functions/src/lib/human-review.ts` → `computeWeightedOverall` | `grade-adjustment.ts`, `routes/admin-disputes.ts`, `routes/admin-grading.ts` |

Plus `ai-grading.ts`, which does the original composite parse with its own
`roundToTenth` — the score the AI report ships with before any human touches it.

**Adding a new surface? Import one of the two. Do not write a third.**

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

Related: the three admin pages no longer re-declare `FactorScores` locally and
no longer cast into `WeightedFactorScores`. The cast was harmless only while the
shapes happened to match; it would have swallowed a dropped or renamed key
silently, which is the compile-time half of this same defect.

## Why this note exists: it has shipped wrong twice

- **US-1557** fixed a divergent copy in `admin/grading.tsx`.
- **US-2041** found the same bug still live in `admin/disputes.tsx`, rounding to
  the nearest **0.5** while every other site rounded to **0.1**. An operator
  adjusting a dispute saw an overall up to **0.2 away** from what was persisted,
  in both directions — 8.5 shown vs 8.3 stored, and 8.5 shown vs 8.7 stored.

US-2034 then consolidated the three admin UIs behind one helper, which is why the
client column above has a single entry. That consolidation is the fix; the
per-file copies are gone.

## Why 0.1 overall and 0.5 factors

Factors move in half-points because they are human-scale judgements. The overall
rounds to a tenth so that a single-factor correction stays visible: fabric
7.0 → 6.5 at 30% weight moves the overall by 0.15 — visible at 0.1 rounding,
**invisible at 0.5**. That is precisely the drift US-2041 hid.

## Related

- [[grading-scale-and-weights]] — the scale and factor weights this computes over
- [[guards-that-cannot-fail]] — why "reviewers will catch it" was not a control
- [[INDEX]]
