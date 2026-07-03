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
