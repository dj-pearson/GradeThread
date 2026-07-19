---
name: grading-engine
description: "Use when editing ANY grading code or data: services/edge-functions/src/lib/ai-grading.ts, grading-pipeline.ts, grading-eval.ts, grading-shadow.ts, accuracy-tracking.ts, human-review*, few-shot-exemplars.ts, peer-norm.ts, fabric-criteria.ts, garment-baselines.ts, defect-weighting.ts, routes/admin-grading.ts, the admin reviews UI (src/pages/admin/reviews.tsx, grading.tsx), grade_reports/human_reviews migrations, or grading prompts. Encodes the grading domain contract: factor weights, rounding lockstep, prompt-version lifecycle, golden set, exemplar privacy, review thresholds."
metadata:
  author: gradethread
  version: "1.0.0"
---

# GradeThread grading engine — the domain contract

Selling point of the whole product is trust in the number. Every rule below
exists because breaking it produces a wrong-but-confident grade or an
unauditable change. When in doubt, make the grade LESS confident, never more.

## Factors, weights, scale

Five factors, graded in **0.5 steps** on 1.0–10.0; the weighted OVERALL is
rounded to **0.1** (so a single-factor human correction actually moves it):

| Factor | Weight |
|---|---|
| fabric_condition | 30% |
| structural_integrity | 25% |
| cosmetic_appearance | 20% |
| functional_elements | 15% |
| odor_cleanliness | 10% |

Tiers: NWT 10 · NWOT 9 · Excellent 8 · Very Good 7 · Good 6 · Fair 5 · Poor 3–4.

## ⚠️ The three rounding sites — LOCKSTEP RULE

The weighted-overall computation exists in THREE places that must stay
byte-for-byte equivalent (same weights, same 0.1 rounding). Changing one means
changing all three in the same commit:

1. `services/edge-functions/src/lib/ai-grading.ts` → `roundToTenth`
2. `services/edge-functions/src/lib/human-review.ts` → `computeWeightedOverall`
3. `src/pages/admin/reviews.tsx` → `computeWeightedScore`

The lockstep map (which implementations exist, and why it shipped wrong
twice) is `vault/20-domain/weighted-overall-lockstep.md` — a drift-guarded
contract note, not a static list.

## Prompt-version lifecycle (never hot-edit a live prompt)

Prompts ship as versioned code defaults (`PER_IMAGE_PROMPT_VERSION` /
`COMPOSITE_PROMPT_VERSION`); an active `ai_prompt_versions` row overrides at
runtime. The ONLY path to changing live grading behavior:

draft row → shadow-compare on live traffic (`grading-shadow.ts`) → golden-set
eval gate (`grading-eval.ts` runEval; thresholds `EVAL_MAX_MAE` /
`EVAL_MIN_AGREEMENT`) → activate (optionally via canary slice, US-896) →
`invalidatePromptCache()`.

Dynamic per-item context (baselines +baseline, fabric +fabric, visual
verification +visual) is flag-gated and suffixes `prompt_version` so
accuracy-tracking can attribute eras. Full lifecycle + suffix rules:
`references/prompt-lifecycle.md`.

## Golden set (grading_eval_cases)

- Grows from REAL corrected grades (human reviews with expert consensus),
  never synthetic fabrications; tag cases (e.g. fabric-sensitive, misread) so
  eval reports slice per tag.
- Never delete cases to make an eval pass. A shrinking golden set is a red
  flag in review.
- Eval runs cost real vision calls — batch changes, don't eval per keystroke.

## Few-shot exemplars (US-1067) — privacy rule

Exemplar sets mine `human_reviews` + approved-claim signals. They may carry
ONLY: garment_category, garment_type, scores, misread flag, generated
rationale. NEVER review_notes, titles, descriptions, user ids, or photos —
exemplars are injected into prompts and could surface in outputs. Sets are
inert until they pass the eval gate and are explicitly activated
(`few-shot-exemplars.ts`; weekly assembly cron `jobs-exemplar-assembly.ts`).

## Review thresholds & confidence caps

- Confidence < **0.75** → `needs_human_review` (the flat threshold).
- Additional forced-review triggers: defect-divergence, authenticity flags,
  partial image set (cap 0.7), peer-norm outlier (cap 0.7, US-1536), ≥2
  visual-verification discrepancies (US-1537).
- Caps COMPOSE via min-of-caps; penalties floor at 0. Never raise confidence
  post-composite. New caps: follow `composeConfidenceCap` (peer-norm.ts).

## Injection defense (US-346)

Seller-supplied text (title, brand, description, declared features) is
UNTRUSTED: sanitized + fenced in prompts, and must never move scores. Trusted
server-generated context (baselines, fabric criteria, exemplars) goes OUTSIDE
the fence — never mix the two channels.

## Checklist for any grading change

1. Rounding sites still in lockstep? (all three, same commit)
2. Prompt text changed → new version name + through shadow/eval/canary, not a
   silent edit; dynamic-context changes → distinct version suffix.
3. New confidence logic → composes via min-of-caps, never raises.
4. Additive features → byte-identical prompts when disabled (test-guarded).
5. Tests: pure logic in `src/tests/*_test.ts`; golden set untouched unless
   adding tagged cases.

## Domain facts live in the vault

This skill owns the **procedure**. The numbers and contracts it operates on live
in `vault/20-domain/`, where they carry `code_refs` and a CI drift guard:

- `vault/20-domain/grading-scale-and-weights.md` — scale, factor weights, and the
  rounding rule that has shipped wrong twice (US-1557, US-2041).
- `vault/20-domain/brands/` — the brand KB's governing RULES. Per-brand VALUES
  live in the `brand_knowledge` tables, not in notes; the notes carry the rules
  that have no column: the decoder bar (tag-printed AND regular AND brand-unique),
  the alias refusals, and the recorded negative findings. Read them before adding
  a decoder or an alias — several absences there are deliberate and look like
  oversights.
- `vault/20-domain/measurement-accuracy.md` — measurement tolerances and validation.

Link to those rather than restating a weight or threshold here: two copies of a
number is how the repo ended up with two contradictory key-rotation procedures.
