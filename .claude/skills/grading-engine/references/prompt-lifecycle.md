# Grading prompt-version lifecycle

## Code defaults vs DB overrides

- Code constants: `PER_IMAGE_PROMPT_VERSION` / `COMPOSITE_PROMPT_VERSION`
  (ai-grading.ts, currently v5 / v4). Bump when the CODE prompt text changes —
  accuracy-tracking attributes grades by version name.
- Runtime override: an `ai_prompt_versions` row (stage `per_image` |
  `composite`, optional `garment_scope`) with `is_active` wins over the code
  default. Empty `prompt_text` = "use code text, attribute to this name".
- Resolution is cached cluster-coherently; activation paths call
  `invalidatePromptCache()`.

## ⚠️ What the gate does NOT cover (US-2301, verified 2026-08-01)

Read the section below as describing the ACTIVATION path only. Two things it
can be misread as promising, and does not:

- **There is no CI gate.** The golden-set eval appears in no GitHub workflow, no
  `package.json` script, not `scripts/verify.mjs`, not the edge `deno.json`. No
  build, PR or deploy is blocked by grading accuracy. `runScheduledEval` (the
  monitor cron) raises alerts and blocks nothing. Editing prompt text in
  `ai-grading.ts` reaches customers without ever touching an eval — the code
  default is what serves when no active DB row overrides it.
- **The code defaults have no DB row.** The only seed migration inserts
  `per_image_v2` / `composite_v2`; the constants are `per_image_v5` /
  `composite_v4`. So the versions actually serving traffic carry no eval result
  and no `qualified_model`. `grading-monitor_test.ts` pins this: bumping a
  version now fails until it is seeded or explicitly declared unseeded.

The activation and canary endpoints DO refuse an un-evaled version
(`checkPromptServingEligibility`, US-2300) — that part is real. It only applies
to versions that go through a DB row.

An empty golden set now raises a critical `golden_set_empty` alert instead of
skipping silently (US-2301). There are zero `grading_eval_cases` INSERTs in the
migration set, so a fresh database starts in exactly that state.

## The gate (never skip)

1. **Draft**: insert the candidate row (inactive).
2. **Shadow** (`grading-shadow.ts`): run it against live traffic without
   affecting shipped grades; compare distributions.
3. **Eval gate** (`grading-eval.ts` `runEval`): score against
   `grading_eval_cases`; must clear `EVAL_MAX_MAE` and `EVAL_MIN_AGREEMENT`
   (env-tunable). Activation endpoints refuse un-evaled versions.
4. **Activate** — optionally as a **canary** (US-896): `is_canary` +
   `rollout_percentage` routes a stable per-submission hash slice; eval,
   dry-run, and quick-grade never see the canary.
5. Watch accuracy-tracking sliced by prompt_version; roll back by
   deactivating (cache invalidates cluster-wide).

## Dynamic-context suffixes

Per-item context blocks are flag-gated and append suffixes to the REPORTED
prompt_version. There are FOUR, and the order is fixed by the concatenation in
`ai-grading.ts` (`compositeGrade`), not by convention:

`+baseline` (US-1533, GRADING_BASELINES env) → `+fabric` (US-1534, fires when a
label fiber read exists) → `+visual` (US-1537, `grading_composite_visual` system
setting) → `+tag` (US-2210, trusted label transcription).

Order matters because `prompt_version` is what accuracy-tracking groups by: the
same four blocks in a different order would report as a different era and split
one version's history in two.

The base version name never changes when a block is merely absent — prompts must
be byte-identical with the feature off. Test-guarded per suffix in
`garment-baselines_test` (+baseline), `fabric-criteria_test` (+fabric),
`composite-visual-verification_test` (+visual) and `prompt-suffix-order_test`
(+tag, plus the order above).

## Exemplar block (US-1067/US-1535)

The active exemplar set's block is appended to the composite SYSTEM prompt on
the live path only (never in eval/dry-run/shadow overrides — those measure the
prompt itself). Exemplar sets pass the SAME eval gate before activation;
assembly runs weekly via `jobs-exemplar-assembly.ts` with auto-activation only
behind `grading_exemplar_auto_activate`.

## The gate pins the MODEL too (US-2036)

`eval_passed` used to be a naked boolean, so a passing run said the prompt
cleared MAE/agreement but not what it cleared them WITH. The grading model is
env config (`DEFAULT_AI_MODEL`), so pointing it at another allowlisted model
inherited a pass it never earned — no deploy, no eval, no audit entry.

`runEval` now stamps `ai_prompt_versions.qualified_model` with the model that
produced the result (and NULLs it on a failing run). `activatePromptVersion`
refuses when it differs from `getGradingCompositeModel()`, and refuses when it
is missing — an unattributable pass is not a pass.

Activation-time checking is necessary but NOT sufficient: the model can change
under an already-active version. `grading-monitor` therefore raises a CRITICAL
`model_not_qualified` alert whenever the live model is not the qualified one.

**Practical consequence:** changing the grading model means re-running the eval
on the active prompt version. There is no way to move the model without it.

## Golden-set governance (US-2037)

"Never delete cases to make an eval pass" is now enforced, not advised:

- `DELETE /eval/cases/:id` is a SOFT delete (`deleted_at` tombstone). Every read
  path filters `deleted_at IS NULL` — except the US-2034 contamination
  exclusion in `few-shot-exemplars.ts`, which deliberately still sees deleted
  rows because a restored case must not silently become an exemplar.
- Both PATCH and DELETE require step-up, matching prompt activation/canary.
- `expected_score` / `expected_tier` are IMMUTABLE (409) once the case has
  appeared in a passing run — editing ground truth retroactively invalidates
  every historical comparison. Retire the case and add a corrected one instead.
- A shrinking ACTIVE golden set raises a CRITICAL `golden_set_shrank` alert,
  measured against its high-water mark over the last 10 runs.
