# The three weighted-overall rounding sites (lockstep map)

All three compute: `overall = roundToTenth(clamp(Σ factor × weight, 1.0, 10.0))`
with weights 0.30 / 0.25 / 0.20 / 0.15 / 0.10 and round-half-up to one decimal.
Any change to weights or rounding must land in ALL THREE in the same commit —
CI (`schema-version_test` siblings) does not catch drift here; reviewers must.

## 1. AI composite — `services/edge-functions/src/lib/ai-grading.ts`

- `roundToTenth(value)` (~line 1500) + the weighted sum in the composite parse
  (`calculatedScore = roundToTenth(Math.max(1.0, Math.min(10.0, weightedSum)))`).
- This is the score the AI report ships with before any human touches it.

## 2. Human-review recompute — `services/edge-functions/src/lib/human-review.ts`

- `computeWeightedOverall(f: FactorScores)` — recomputes the overall after a
  reviewer adjusts individual factor scores. If this drifts from site 1, a
  review that changes NOTHING would still move the grade.

## 3. Admin reviews UI — `src/pages/admin/reviews.tsx`

- `computeWeightedScore(factors)` (~line 170) — the LIVE preview the reviewer
  sees while dragging factor sliders. If this drifts from site 2, the reviewer
  approves a number different from what persists.

## Why 0.1 overall / 0.5 factors

Factors move in half-points (human-scale judgments); the overall rounds to a
tenth so a single-factor correction (e.g. fabric 7.0 → 6.5, weight 30%)
changes the overall by 0.15 → visible at 0.1 rounding, invisible at 0.5.
