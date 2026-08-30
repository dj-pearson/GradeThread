---
title: Grading scale, factor weights and rounding
aliases: [grading scale, factor weights, GRADE_FACTORS]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/constants.ts
  - src/lib/weighted-grade.ts
  - src/lib/grading-standard.ts
  - services/edge-functions/src/lib/ai-grading.ts
  - services/edge-functions/src/lib/human-review.ts
  - services/edge-functions/src/lib/defect-weighting.ts
  - services/edge-functions/src/tests/weighted-grade-parity_test.ts
reviewed: 2026-08-30
tags: [grading, contract]
summary: The 1.0-10.0 scale, the five weighted factors, the rounding rule that has now shipped wrong twice, and which engine criteria are published and therefore no longer free to tune.
---

# Grading scale, factor weights and rounding

> **Editing grading code? Load the `grading-engine` skill first.** It owns the
> full operational contract — prompt-version lifecycle, golden set, exemplar
> privacy, confidence-cap composition. This note holds the *numbers* and the
> rounding rule; the skill holds the *procedure*.

## Scale

Grades run **1.0 – 10.0**. Individual factors are scored in **0.5 steps**; the
weighted overall is rounded to **0.1**. Tiers run NWT (10) down to Poor (3–4).

> **Where the bands live (US-2871).** `GRADE_TIER_BANDS` in
> `src/lib/constants.ts` is the single table mapping a tier to its inclusive
> floor, and `tierBandForScore()` / `tierBandRange()` are the only readers.
> `tierLabelForGrade()` in `condition-value-curve.ts` used to carry its own
> copy of the numbers and now delegates. One thing the table says that the
> published scale does not: Poor's floor is **1.0**, not 3.0. The scale calls
> Poor 3–4, but a grade can come back below 3 and it still has to render as
> something.

Confidence below **0.75** routes the submission to human review.

Required photos: front, back, label, and at least one detail shot.

### 0.75 and 0.9 are two different gates, not a mismatch (US-2309, 2026-08-15)

This pair has been read as a contradiction more than once, including by the
story that finally settled it, so state it as the two-stage gate it is:

| Confidence | What happens |
|---|---|
| below **0.75** | `needs_human_review` is set — mandatory review |
| 0.75 to below **0.9** | not flagged, and not auto-approved either — it waits for a human anyway |
| **0.9** and above, clean and unflagged | finalizes with no human (`GRADE_AUTO_APPROVE_CONFIDENCE`, env-tunable, "off" disables it) |

So the public claim — anything under 0.75 gets a human — is TRUE and
conservative: in practice everything under 0.9 does. A client that says a grade
at 0.80 is "high enough to certify automatically" is wrong, and iOS said exactly
that until US-2309.

**A client must not re-derive the second number.** It is server-side and
env-tunable, and the app cannot know it. iOS now describes only the threshold it
owns ("above the review threshold"), which is the same lesson US-1409 recorded
three times in `GradeReportView.swift`: read certification from server state,
never from raw confidence.

### The quick-grade path carries the same caps (US-2309)

`quick-grade.ts` — Snap-to-Value and the browser extension — used to return the
composite's verdict raw, so it saw none of the post-composite caps: partial
image set, peer-norm outlier, visual-verification discrepancies. It could report
0.8 where the full path capped at 0.6, on the surface where the number is most
externally visible. It now runs `applyPostCompositeCaps`, which shares the
constants with the pipeline rather than copying them.

## Factor weights

Canonical source is `GRADE_FACTORS` in `src/lib/constants.ts` (verified
2026-07-18):

| Factor | Key | Weight |
|---|---|---|
| Fabric Condition | `fabric_condition` | 0.30 |
| Structural Integrity | `structural_integrity` | 0.25 |
| Cosmetic Appearance | `cosmetic_appearance` | 0.20 |
| Functional Elements | `functional_elements` | 0.15 |
| Odor & Cleanliness | `odor_cleanliness` | 0.10 |

Weights sum to 1.00. Every UI surface reads `GRADE_FACTORS` rather than restating
the numbers — keep it that way.

## The rounding rule, and why it has its own section

**The weighted overall rounds to 0.1 — `Math.round(total * 10) / 10` — at every
site, without exception.**

This has shipped wrong **twice**:

- **US-1557** fixed one divergent copy in `admin/grading.tsx`.
- **US-2041** found the same bug still live in `admin/disputes.tsx`, which was
  rounding to 0.5 (`Math.round(total * 2) / 2`). An operator adjusting factor
  scores on a dispute saw an overall up to **0.2 away** from what the server
  persisted, in both directions.

Grade tier is a pricing-band input, and the resealed certificate hash makes the
stored number look authoritative. So the drift is not cosmetic — it misprices
garments and does so under a certificate that implies verification.

The structural fix was to stop having N copies: `src/lib/weighted-grade.ts` is now
the shared frontend implementation. The remaining sites that must stay in lockstep
are enumerated in `.claude/skills/grading-engine/references/rounding-sites.md` —
that list is authoritative, and this note deliberately does not duplicate it.

**If you add a surface that computes a weighted overall, import the shared helper.
Do not reimplement the arithmetic.**

## Published criteria — which engine values are now public (US-2107)

Three tables in `services/edge-functions/src/lib/defect-weighting.ts` are
**mirrored onto the public `/condition-grading` page** by
`src/lib/grading-standard.ts`:

| Engine table | What it publishes |
|---|---|
| `SIZE_BUCKETS` | the millimetre tolerances (pinhole <3mm, small 3–13mm, medium 13–50mm, large >50mm) |
| `SEVERITY_MULT` | the severity multipliers |
| `FACTOR_ROUTING` | which factor each defect type hits |

**They stopped being internal calibration on 2026-07-19.** Before that, tuning
one was a private change that accuracy tracking absorbed. Now it edits a
published spec, on a page whose stated purpose is to be cited and lifted
verbatim into LLM answers — so a stale mirror is a precise, checkable, *wrong*
public claim, which is worse than the vague adjectives it replaced.

The finding behind US-2107 is worth keeping: we were never missing a measurable
standard. The engine has carried these millimetre buckets and the routing table
since **US-1028**. We were failing to *publish* them. Nothing was invented for
the page.

### The rule

Changing any of those three tables is a **public-standard change**, not a
tuning change. It needs the mirror updated in the same commit, and it deserves
the same deliberation as changing a published price.

`FACTOR_ROUTING` gained a **second consumer** on 2026-08-07 (US-1997): it is now
also the clothing rubric's `defectRouting` in
`services/edge-functions/src/lib/rubric.ts`, which references the exported table
rather than restating part of it. So that table is simultaneously the live
engine's routing, a published spec, and the clothing rubric — three readers, one
definition, which is the intended shape. It had been hand-copied into rubric.ts
as a three-entry subset of sixteen; see [[shipped-but-unwired]] for why nobody
noticed.

> [!warning] `deno test` alone will not catch you
> `src/test/grading-standard-parity.test.ts` is the guard, and it lives in the
> **web** project. The edge suite passes happily while the mirror is stale. Run
> `npm run verify`, or rely on CI running both lanes, for any change here.

### `BASE_WEIGHT` is deliberately NOT published

The exact score-points penalty per defect type stays internal. Publishing which
factor a flaw hits makes the standard **auditable**; publishing the exact
arithmetic makes it **gameable** — a seller who knows the numbers photographs to
minimise them, and the grade stops measuring the garment.

A test asserts it stays out. This is a product trade-off, not an oversight, so
reversing it is a product call rather than a completeness fix. Anyone "finishing"
the published standard by adding it should read this paragraph first.

## Related

- [[INDEX]]
- [[brand-taxonomy-overview]] — brand tiering that feeds grading context
- [[CONTRACT]] — why this note is `type: contract` and gets strict CI treatment
