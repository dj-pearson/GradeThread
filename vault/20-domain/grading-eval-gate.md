---
title: The grading eval gate — what it blocks, and why it is not a PR check
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/grading-eval.ts
  - services/edge-functions/src/lib/grading-monitor.ts
  - services/edge-functions/src/tests/grading-eval-gate_test.ts
  - services/edge-functions/src/tests/golden-set-growth_test.ts
  - scripts/grading-eval-ci.mjs
  - .github/workflows/grading-eval.yml
reviewed: 2026-09-26
tags: [grading, eval, ci, accuracy]
summary: The golden-set eval gates prompt ACTIVATION, not the build; it cannot gate a PR (real vision calls, a set that must not be synthetic), but a weekly scheduled workflow fails on regression or an empty set.
---

# The grading eval gate

## What it gates

A candidate prompt version must clear **both** thresholds before it may serve
live traffic (`evalThresholds()` in `grading-eval.ts`):

| Threshold | Default | Env override |
|---|---|---|
| Max mean absolute error | **0.5** | `EVAL_MAX_MAE` |
| Min agreement | **0.7** | `EVAL_MIN_AGREEMENT` |

The MAE default was **1.0** until 2026-08-15 (US-2301 AC6). On a 1.0–10.0 scale
rounded to 0.1, a full point is an entire grade — the gap between Excellent and
Good — so a candidate could be that wrong on average and still be promoted, on
the one number the product sells. 0.5 is one tier rather than two, and still
generous. **0.3 was considered and refused for now**: it is close to the
disagreement between two human experts, and the golden set is not yet large
enough to distinguish a real regression from an unrepresentative sample.

Changing it changes **no grade**. It decides only what may be promoted. The
override exists so a deliberate, argued exception is one env var while the
silent default stays strict.

> [!important] These numbers are published
> `evalThresholds()` also feeds the public transparency report
> (`accuracy-tracking.ts` → `src/pages/marketing/transparency.tsx`), which
> prints the gate as a promise to buyers. It renders from the code, so it
> follows automatically — but it also means loosening the gate loosens a public
> claim.

## Why it is not a PR check (US-2301 AC2)

The acceptance criterion offered two outcomes: run it in CI and fail the build
on regression, **or write down why it cannot**. This is the second, and the
reason is not "nobody got to it".

1. **Every run spends real money.** The eval grades each golden case through the
   vision model. A per-PR gate would bill a full golden set per push, on a
   corpus that has to *grow* to stay meaningful — so the cost scales with the
   thing that makes the gate worth having.
2. **The result is not deterministic.** Grading is not temperature-pinned on the
   default model (US-2035), so the same prompt against the same case can move
   between runs. A build gate that fails on noise gets bypassed, and this repo
   already has that lesson written down twice: `db-denied-rpc-crash-check.mjs`
   is advisory for the same reason, and US-1927's notes record a permanently-red
   guard being switched off.
3. **The golden set cannot be faked to make CI green.** Cases come from real
   corrected grades with expert consensus, never fabrications. There is no
   fixture that would let this run offline and still mean anything — a synthetic
   set would turn the gate into a test of the fixture.

**What gates instead, and it is the stronger gate:** activation. A prompt
version cannot go active without a passing eval recorded against it, so the
check sits at the moment the change would reach a customer rather than at the
moment it reaches `main`. Shipping prompt text to `main` is not shipping it to
graders — the lifecycle is draft → shadow → eval → canary → active
([[grading-prompt-channels]]).

**What CI does enforce**, so the gap is narrower than "no CI coverage":
`grading-eval-gate_test.ts` pins the thresholds themselves, and US-2301 AC5
enforces that prompt text cannot ship without a corresponding evaluated version.

**The scheduled run (grading plan action 3, 2026-09-23).** Reasons 1 and 2 rule
out a per-push gate, not a periodic one. `.github/workflows/grading-eval.yml`
runs weekly (and on `workflow_dispatch`) and POSTs `/api/jobs/grading-monitor`,
so the eval runs on the edge against the live composite version and GitHub
holds only `EDGE_JOB_SECRET`, never a model or service-role key.
`scripts/grading-eval-ci.mjs` judges the response, and it is stricter than the
monitor on purpose: the monitor answers an empty set with a 200 and
`eval.ran: false`, which this job treats as a **failure**, along with any other
skip, a failed threshold, a regression against the previous run, a shrunk set
and an unqualified live model. Production-metric alerts only warn. Without the
secret it skips with exit 0; forks never run it. It is a monitor, not a deploy
gate: it never runs on push or pull_request, which is what keeps the public
pages' "the code-shipped prompt clears no gate" caveat true
(`src/test/eval-gate-claims.test.ts` pins that). Until the owner promotes real
cases and seeds rows for the live code defaults, this job is expected to be
red, and that red is the accurate reading.

## The thing that actually makes this hollow

An empty `grading_eval_cases` is the gate being **switched off**, not "nothing
to check": with no cases the eval never runs, `eval_passed` stays null rather
than false, and no other rule in `evaluateAlerts` fires. US-2301 AC4 made an
empty set a hard failure for that reason. As of the last check the production
set was unverified — that is AC1, and it is an operator read.

**Prod read, 2026-09-10 (owner, §15 of `scripts/prod-diagnostics-console.sql`):**
`ai_prompt_versions` holds four rows (`per_image_v2`, `composite_v2`,
`listing_gen_v1`, `listing_gen_v2`), **none active, none with `eval_passed`**. So
the code defaults `per_image_v5` and `composite_v4` serve every grade with no row
and no eval behind them. The golden-set count from the same section was not
reported; nothing has ever inserted a case, so expect zero.

**Too thin is refused too (US-3522, 2026-09-26).** An empty set was the only
refusal, so three tops rated Good could pass a prompt that grades everything.
`runEval` now calls `goldenSetGaps` before any vision call and throws naming
the gap: an unscoped run needs `GRADING_EVAL_MIN_CASES` (default 20) cases and
at least one in every tier NWT to Poor; a run scoped to one category needs
`GRADING_EVAL_MIN_SCOPED_CASES` (default 5). The set also grows on its own now:
a review adjustment or dispute that moves a grade by a point or more, or flags
an intentional-design misread, is queued as an INACTIVE candidate by
`autoQueueEvalCandidate`. An admin still approves each one before it counts.

**Activation now needs more than a pass (US-3526, 2026-09-26).** For a grading
prompt, `activatePromptVersion` also refuses a candidate whose latest passing
eval is worse than the champion's (MAE +0.05, agreement -0.02 tolerance), and
one with fewer than `GRADING_ACTIVATION_MIN_LIVE_SAMPLES` (default 20) scored
shadow results and canary grades. A monitor alert, `serving_unevaluated_prompt`,
also fires every run while a stage serves a version that could not pass this
gate, including a code default with no row (US-3521).

A corrected grade is only useful here if its AI score survived the correction.
Until US-3323 the accuracy readers compared the reviewer's score with itself; see
[[review-accuracy-baseline]] for which number is the AI's.

Related: [[grading-prompt-channels]] for how a prompt reaches live traffic,
[[grading-scale-and-weights]] for what the number means.
