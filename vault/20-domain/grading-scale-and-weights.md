---
title: Grading scale, factor weights and rounding
aliases: [grading scale, factor weights, GRADE_FACTORS]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/constants.ts
  - src/lib/weighted-grade.ts
  - services/edge-functions/src/lib/ai-grading.ts
  - services/edge-functions/src/lib/human-review.ts
reviewed: 2026-07-18
tags: [grading, contract]
summary: The 1.0-10.0 scale, the five weighted factors, and the rounding rule that has now shipped wrong twice.
---

# Grading scale, factor weights and rounding

> **Editing grading code? Load the `grading-engine` skill first.** It owns the
> full operational contract — prompt-version lifecycle, golden set, exemplar
> privacy, confidence-cap composition. This note holds the *numbers* and the
> rounding rule; the skill holds the *procedure*.

## Scale

Grades run **1.0 – 10.0**. Individual factors are scored in **0.5 steps**; the
weighted overall is rounded to **0.1**. Tiers run NWT (10) down to Poor (3–4).

Confidence below **0.75** routes the submission to human review.

Required photos: front, back, label, and at least one detail shot.

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

## Related

- [[INDEX]]
- [[brand-taxonomy-overview]] — brand tiering that feeds grading context
- [[CONTRACT]] — why this note is `type: contract` and gets strict CI treatment
