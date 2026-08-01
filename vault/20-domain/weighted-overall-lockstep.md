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
reviewed: 2026-08-01
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
