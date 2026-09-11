---
title: AI vs human accuracy - which number is the AI's
aliases: [review baseline, AI side, human side, US-3323]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/review-baseline.ts
  - services/edge-functions/src/lib/grade-adjustment.ts
  - services/edge-functions/src/lib/accuracy-tracking.ts
  - services/edge-functions/src/lib/defect-accuracy.ts
  - services/edge-functions/src/lib/few-shot-exemplars.ts
  - services/edge-functions/src/routes/jobs-confidence-calibration.ts
  - services/edge-functions/src/tests/review-baseline_test.ts
  - supabase/migrations/00784_human_review_ai_baseline.sql
reviewed: 2026-09-10
tags: [grading, accuracy, calibration, human-review, contract]
summary: Once a reviewer adjusts a grade, grade_reports holds the human's scores, so the AI's side of every accuracy comparison must come from the earliest human_reviews snapshot, never from the report.
---

# Which number is the AI's

Every accuracy figure in GradeThread compares two numbers: what the AI said and
what a human decided. After an adjustment they live in different places, and
reading the wrong one makes the AI look perfect.

## The rule

| Side | Where it comes from | Why |
|---|---|---|
| **AI** | the grade's **earliest** `human_reviews` row: `original_score` and, since 00784, the five `original_*` factors | each review records the scores it found before acting, so the first row holds the number no human had touched |
| **Human** | the report's **current** `grade_reports` scores | every review path writes its decision onto the report |

`buildReviewedGrades` in `review-baseline.ts` is the only implementation. Every
reader goes through it, and a source guard in `review-baseline_test.ts` fails if
one compares `report.overall_score` with a human score again.

**Send-backs are not verdicts.** `review_action = 'send_back'` means the photos
could not support a grade. Those rows are dropped from accuracy, calibration,
defect bias and exemplars.

**Unknown is not zero.** A grade adjusted before 00784 lost its AI factors when
`applyGradeAdjustment` overwrote the report. Its overall error still counts. Its
factors report as null and are left out of per-factor figures. A never-adjusted
report still holds the AI's output, so it can stand in for a missing snapshot.

## What went wrong before (US-3323)

`applyGradeAdjustment` writes the correction over the report. Every reader then
took the report's score as the AI's, so a grade the AI called 7.6 and a reviewer
moved to 7.9 was measured as `|7.9 - 7.9| = 0`. Found 2026-09-10, before any real
review volume existed, while preparing a 150-grade owner review campaign. What it
touched:

- accuracy summary, and the public transparency figures built on it
- the confidence-calibration miner, which would have read "never wrong" and
  lowered the review threshold
- defect-type bias, the few-shot exemplar miner, and the training export

## Adding a review path

A new `human_reviews` insert must spread `reviewSnapshot(report)` taken **before**
the report changes, and set `review_action`. The source guard counts the inserts
and fails on a fifth one until it is added on purpose.

Related: [[grading-eval-gate]] for how corrected grades become golden cases,
[[weighted-overall-lockstep]] for how the human's overall is computed.
