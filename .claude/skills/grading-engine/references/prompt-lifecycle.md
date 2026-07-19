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
prompt_version (deterministic order): `+baseline` (US-1533, GRADING_BASELINES
env), `+fabric` (US-1534, fires when a label fiber read exists), `+visual`
(US-1537, `grading_composite_visual` system setting). The base version name
never changes when a block is merely absent — prompts must be byte-identical
with the feature off (test-guarded in garment-baselines_test /
fabric-criteria_test / composite-visual-verification_test).

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
