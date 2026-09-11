import Anthropic from "@anthropic-ai/sdk";
import { runAiCall } from "./ai-limiter.ts";
import { getSettingSync } from "./system-settings.ts";
import { currentAiFeature } from "./ai-feature-context.ts";
// Type-only: erased at runtime, so lib/operator-model-guard.ts stays a pure
// module with no imports of its own and no cycle back into this one.
import type { ModelResolution } from "./operator-model-guard.ts";

// Central reader for AI configuration. Values come from Coolify Team Shared
// Variables so every Pearson Media project flips together when a model or
// timeout changes. Each function falls back to a safe default so a missing
// var never breaks a deploy — only a missing API key does.

const DEFAULTS = {
  model: "claude-sonnet-5",
  lightweightModel: "claude-haiku-4-5-20251001",
  // Image generation runs through OpenAI's images API (gpt-image-1) — the
  // Anthropic models don't render images. Kept here so the model is a single
  // shared-config value, never hardcoded at the call site (US-853).
  imageModel: "gpt-image-1",
  timeoutMs: 120_000,
  maxRetries: 2,
  enableCaching: true,
} as const;

function readNumber(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = Deno.env.get(name);
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function getAnthropicApiKey(): string {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("CLAUDE_API_KEY");
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY (or CLAUDE_API_KEY) environment variable is not set"
    );
  }
  return key;
}

// ── The two variables that decide every model, and how they go wrong ─────────
//
// THE INTENT: one Coolify TEAM variable per tier, referenced by every service.
// The edge service's own environment should read
//   DEFAULT_AI_MODEL={{team.DEFAULT_AI_MODEL}}
//   LIGHTWEIGHT_AI_MODEL={{team.LIGHTWEIGHT_AI_MODEL}}
// so a model change is ONE edit at the team level and nobody hunts for pins.
//
// TWO FAILURE MODES, and neither announces itself:
//
//   1. THE REFERENCE IS NOT EXPANDED. If the service env holds the literal
//      "{{team.DEFAULT_AI_MODEL}}", that string is sent as `model` and every
//      call fails with a 404 naming a model that does not exist. The error
//      never mentions Coolify, so it reads as an outage.
//
//   2. THE VARIABLE IS SET TO A STALE ID. This one is silent and expensive: a
//      previous-generation id is a REAL model, so calls succeed and only the
//      ledger shows it. On 2026-09-02 an operator script ran 169 prod tag reads
//      on claude-sonnet-4-6 because a dev .env still pinned the pre-2026-07
//      default (US-3184), and nothing anywhere said so.
//
// So the resolver below reports both, once per process, rather than trusting
// the value it is handed. It never throws: a loud log plus the code default
// beats taking AI down over a config typo.

/** Model ids this generation of the code expects to be routed to. */
export const CURRENT_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
]);

/** An unexpanded Coolify / template reference, e.g. "{{team.DEFAULT_AI_MODEL}}". */
export function isUnexpandedTemplate(value: string): boolean {
  return /\{\{|\}\}|\$\{/.test(value);
}

const warnedModelVars = new Set<string>();

/**
 * Read a model-selecting env var, or fall back to the code default.
 *
 * Warns ONCE per variable per process on an unexpanded template or an id this
 * generation does not expect, then returns the code default for the template
 * case (which is never a usable model) and the configured value otherwise (an
 * unfamiliar id may be a deliberate pin or simply newer than this constant).
 */
function resolveModelVar(name: string, codeDefault: string): string {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return codeDefault;

  if (isUnexpandedTemplate(raw)) {
    if (!warnedModelVars.has(name)) {
      warnedModelVars.add(name);
      console.error(
        `[ai-config] ${name}="${raw}" was never expanded - the deploy is passing ` +
          `the reference text through instead of the team variable's value. ` +
          `Using ${codeDefault}. Fix it in the Coolify service environment; ` +
          `sending this string as a model would 404 every AI call.`,
      );
    }
    return codeDefault;
  }

  if (!CURRENT_MODEL_IDS.has(raw) && !warnedModelVars.has(name)) {
    warnedModelVars.add(name);
    console.warn(
      `[ai-config] ${name}="${raw}" is not a model id this build expects ` +
        `(${[...CURRENT_MODEL_IDS].join(", ")}). Honouring it, because a newer ` +
        `id is legitimate - but if this is a previous-generation model, every ` +
        `call it serves is silently on the wrong one. See US-3184.`,
    );
  }
  return raw;
}

/**
 * The model this BUILD would use with no environment at all.
 *
 * Exported so an operator script can compare what it is about to spend against
 * what the deployed service resolves to, without importing DEFAULTS wholesale
 * or hardcoding the id a second time (US-3184).
 */
export const CODE_DEFAULT_MODEL: string = DEFAULTS.model;

// ── Operator arming: a declared tier list that undeclared tiers fall foul of ──
//
// US-3184 follow-up, and the part that is a MECHANISM rather than an edit.
//
// checkModelDrift() can only vet the tiers a script tells it about. Version one
// of that contract was a promise: the script named getDefaultModel(), and
// nothing checked that getDefaultModel() was the only resolver its call path
// reached. A static scan of the import closure cannot settle it either -
// scripts/backfill-tag-reads.ts imports ai-listing.ts for ONE pure helper and
// thereby "reaches" five tiers it never spends on, so a closure rule is all
// false positives and teaches an operator to paste --allow-model-drift.
//
// So it is enforced where the truth is: at resolution. An operator script arms
// this by calling resolveOperatorModels([...]); from then on, resolving a tier
// it did not declare THROWS, before the id ever reaches an API call. The edge
// service never arms it (declaredTiers stays null), so nothing changes in
// production request handling.
//
// Nested resolution is expected and allowed - getSizeEstimateModel() falls back
// through getLightweightModel(), getGradingCompositeModel() through
// getDefaultModel() - so only the OUTERMOST resolution is checked.
let declaredTiers: ReadonlySet<ModelTier> | null = null;
let resolveDepth = 0;

function assertTierDeclared(tier: ModelTier): void {
  if (declaredTiers === null || resolveDepth > 0) return;
  if (declaredTiers.has(tier)) return;
  throw new Error(
    `[ai-config] this operator script is resolving the "${tier}" model tier ` +
      `(${MODEL_TIERS[tier].env}, ${MODEL_TIERS[tier].what}) but declared only ` +
      `[${[...declaredTiers].join(", ")}] to checkModelDrift.\n` +
      `  The drift guard therefore never vetted it, and a stale ` +
      `${MODEL_TIERS[tier].env} would spend against production unannounced - ` +
      `which is what happened to DEFAULT_AI_MODEL on 2026-09-02 (US-3184).\n` +
      `  Add "${tier}" to the resolveOperatorModels([...]) call in this script.`,
  );
}

/** Run a tier's resolver with nested resolutions exempt from the arming check. */
function resolvingTier<T>(fn: () => T): T {
  resolveDepth++;
  try {
    return fn();
  } finally {
    resolveDepth--;
  }
}

/** Test seam: disarm between cases so one test cannot leak into the next. */
export function resetOperatorModelTiersForTests(): void {
  declaredTiers = null;
  resolveDepth = 0;
}

export function getDefaultModel(): string {
  assertTierDeclared("default");
  return resolveModelVar("DEFAULT_AI_MODEL", DEFAULTS.model);
}

export function getLightweightModel(): string {
  assertTierDeclared("lightweight");
  return resolveModelVar("LIGHTWEIGHT_AI_MODEL", DEFAULTS.lightweightModel);
}

/** Test seam: let a test observe the warn-once behaviour more than once. */
export function resetModelVarWarningsForTests(): void {
  warnedModelVars.clear();
}

/**
 * Model for the size-estimate vision pass (US-2924).
 *
 * Its own knob rather than a bare getLightweightModel() call, because the size
 * pass is the one feature that earned a model decision on measured evidence:
 * over 30 days on production it was the most expensive user AI action at
 * $0.0886 a call, roughly twice the blended rate, and at the Business plan's
 * 2,000 actions it is the single reason that plan does not cover its own
 * allowance. Haiku 4.5 takes input from $3/MTok to $1 and output from $15 to $5.
 *
 * Separate from LIGHTWEIGHT_AI_MODEL so an operator can roll THIS back after a
 * bad week of sizing without also moving every other lightweight caller, and so
 * the reason above stays attached to the thing it justified.
 *
 * NOT used by the grading pipeline, which pins getDefaultModel() explicitly —
 * the size pass feeds tagGroundTruthBlock and therefore the grading prompt, and
 * swapping a model under that is a grading change with no shadow compare and no
 * prompt-version suffix. src/tests/ai-model-tiering_test.ts guards the pin.
 */
export function getSizeEstimateModel(): string {
  assertTierDeclared("sizeEstimate");
  return Deno.env.get("SIZE_ESTIMATE_AI_MODEL")?.trim() ||
    resolvingTier(getLightweightModel);
}

/**
 * Model for the cross-list copy kit's text pass (2026-09-02).
 *
 * That pass rewrites ONE finished eBay listing into Poshmark / Mercari / Depop
 * / Grailed / Vinted voice, with every fact pinned to the source. It sees no
 * photos and decides nothing about the garment, so it is the textbook case for
 * the lightweight tier; it ran on getDefaultModel() only because it was written
 * before the tier existed. Now that the kit is generated with every draft
 * rather than on a button, the difference is paid on every item.
 *
 * Same override shape as the size pass, and separate from LIGHTWEIGHT_AI_MODEL
 * for the same reason: an operator can move this one back without touching
 * every other lightweight caller.
 */
export function getPlatformVariantModel(): string {
  assertTierDeclared("platformVariant");
  return Deno.env.get("PLATFORM_VARIANT_AI_MODEL")?.trim() ||
    resolvingTier(getLightweightModel);
}

/**
 * Model for the AutoLister photo-QA pass (US-2924).
 *
 * Second most expensive user AI action on production: $11.33 over 209 calls,
 * $0.0542 each against a $0.0477 blend. AutoLister spends one action per item
 * AND one per cover photo, so a 20-item batch can spend 40 on QA alone.
 *
 * ⚠ THE SCORE IS A GATE, NOT JUST A DISPLAY. `isGreenDraft` in
 * auto-publish-green.ts auto-publishes a draft to a live marketplace when the
 * score is at or above AUTO_PUBLISH_QA_MIN (80), and that floor was calibrated
 * against scores from the FULL model. The two error directions are not equally
 * priced: scoring too LOW costs a seller a manual review, scoring too HIGH puts
 * bad photos on eBay. Re-check the floor against real Haiku scores before
 * trusting the auto-publish path at volume — the knob below is what makes that
 * a one-line rollback rather than a deploy.
 */
export function getPhotoQaModel(): string {
  assertTierDeclared("photoQa");
  return Deno.env.get("PHOTO_QA_AI_MODEL")?.trim() ||
    resolvingTier(getLightweightModel);
}

// US-853: image model for hero/social-card generation. Read from the shared
// config (DEFAULT_IMAGE_MODEL Coolify var) so it flips centrally; falls back to
// gpt-image-1. Never hardcode the model at the call site.
export function getDefaultImageModel(): string {
  assertTierDeclared("image");
  return Deno.env.get("DEFAULT_IMAGE_MODEL")?.trim() || DEFAULTS.imageModel;
}

// US-482: models vetted for grading. An operator override
// (GRADING_COMPOSITE_MODEL) that is NOT on this list would silently change
// grading behavior + reproducibility, so it's rejected (with a loud warning) in
// favor of the built-in default rather than trusted blindly. Extend deliberately
// when a new model is qualified against the eval gate.
export const GRADING_MODEL_ALLOWLIST: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-sonnet-5",
  // Retained so grades produced on the prior default stay reproducible / re-gradable.
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  DEFAULTS.model,
  DEFAULTS.lightweightModel,
]);

export function isAllowedGradingModel(model: string): boolean {
  return GRADING_MODEL_ALLOWLIST.has(model.trim());
}

// Model for the grading composite step — a text-only synthesis of the
// per-image vision results. Defaults to the vision model so behavior is
// unchanged unless an operator deliberately routes it to a cheaper model.
// US-482: the override is validated against the allowlist; an unknown value is
// refused (warn + fall back to the default) so an unvetted model can't quietly
// grade traffic.
export function getGradingCompositeModel(): string {
  assertTierDeclared("gradingComposite");
  const override = Deno.env.get("GRADING_COMPOSITE_MODEL")?.trim();
  if (override) {
    if (isAllowedGradingModel(override)) return override;
    console.warn(
      `[ai-config] GRADING_COMPOSITE_MODEL="${override}" is NOT on the grading ` +
        `allowlist — falling back to the default grading model. Add it to ` +
        `GRADING_MODEL_ALLOWLIST once qualified against the eval gate.`,
    );
  }
  return resolvingTier(getDefaultModel);
}

/**
 * The model that will ACTUALLY serve traffic for a prompt version's stage.
 *
 * US-2307. `ai_prompt_versions.stage` is one of three, and they do not all run
 * on the same model:
 *
 *   per_image   → getDefaultModel()          (the vision call, ai-grading.ts)
 *   composite   → getGradingCompositeModel() (the text synthesis)
 *   listing_gen → getDefaultModel()          (ai-listing.ts)
 *
 * The eval gate (US-2036) exists to prove a prompt was qualified on the model
 * that will serve it. Both the activation gate and the canary route compared
 * every stage against getGradingCompositeModel(), which is right for exactly
 * one of the three. So the proof was being made against the wrong model for
 * per_image and listing_gen — which is the same hole US-2036 closed, reopened
 * one stage over.
 *
 * TODAY THIS IS A NO-OP, and that is the point: getGradingCompositeModel()
 * returns getDefaultModel() unless GRADING_COMPOSITE_MODEL is set, so with no
 * override all three stages resolve to the same string and nothing changes.
 * The divergence only appears the moment an operator deliberately splits the
 * models — which is precisely when the old code started attributing a prompt to
 * a model that never ran it.
 *
 * An unknown stage resolves to the grading composite model, the strictest of
 * the three: a stage nobody has classified should not get a laxer gate than the
 * ones that were.
 */
export function servingModelForStage(stage: string): string {
  switch (stage) {
    case "per_image":
    case "listing_gen":
      return getDefaultModel();
    case "composite":
      return getGradingCompositeModel();
    default:
      return getGradingCompositeModel();
  }
}

// ── Every model-selecting knob, in one enumerable place (US-3184) ────────────
//
// WHY A TABLE AND NOT A LIST OF CALLS. The operator guard compares what a
// script is ABOUT to spend against what the deployed build would resolve to.
// Version one of that guard checked getDefaultModel() and nothing else, which
// was correct for the two scripts that existed on 2026-09-08 and silently wrong
// for the next one: `backfill-tag-reads.ts` already imports ai-listing.ts and
// ai-extract.ts, and those resolve getPlatformVariantModel() and
// getLightweightModel(). The day somebody calls one of them from a script, the
// banner keeps printing the DEFAULT tier, the stale LIGHTWEIGHT_AI_MODEL beside
// it in the same .env goes unmentioned, and 2026-09-02 repeats one tier over.
//
// So the knobs are enumerated rather than remembered. Two things hang off that:
//   - a script names the TIERS it spends on and the guard resolves them itself,
//     so it cannot report a model it is not actually using;
//   - src/tests/operator-model-guard_test.ts greps THIS FILE for every
//     Deno.env.get("*_MODEL") read and fails if one is missing from the table,
//     so a knob added next quarter joins the guard whether or not the person
//     adding it has read this comment.
//
// `codeDefault` is the id this BUILD would use with the environment empty. It
// is the comparison target because it is the only definition of "what this data
// would have been written with normally" that does not itself come from the
// environment being audited.
export interface ModelTierSpec {
  /** The environment variable an operator would set to change this tier. */
  env: string;
  /** What this build resolves to with that variable (and its fallbacks) unset. */
  codeDefault: string;
  /** Live resolution, warnings and all. */
  resolve: () => string;
  /** One line for the banner, so an unfamiliar tier name is self-explaining. */
  what: string;
}

export const MODEL_TIERS = {
  default: {
    env: "DEFAULT_AI_MODEL",
    codeDefault: DEFAULTS.model,
    resolve: getDefaultModel,
    what: "vision + composite work",
  },
  lightweight: {
    env: "LIGHTWEIGHT_AI_MODEL",
    codeDefault: DEFAULTS.lightweightModel,
    resolve: getLightweightModel,
    what: "text-only enrichment",
  },
  sizeEstimate: {
    env: "SIZE_ESTIMATE_AI_MODEL",
    codeDefault: DEFAULTS.lightweightModel,
    resolve: getSizeEstimateModel,
    what: "the size-estimate vision pass",
  },
  platformVariant: {
    env: "PLATFORM_VARIANT_AI_MODEL",
    codeDefault: DEFAULTS.lightweightModel,
    resolve: getPlatformVariantModel,
    what: "cross-list copy variants",
  },
  photoQa: {
    env: "PHOTO_QA_AI_MODEL",
    codeDefault: DEFAULTS.lightweightModel,
    resolve: getPhotoQaModel,
    what: "the AutoLister photo-QA pass",
  },
  gradingComposite: {
    env: "GRADING_COMPOSITE_MODEL",
    codeDefault: DEFAULTS.model,
    resolve: getGradingCompositeModel,
    what: "the grading composite synthesis",
  },
  image: {
    env: "DEFAULT_IMAGE_MODEL",
    codeDefault: DEFAULTS.imageModel,
    resolve: getDefaultImageModel,
    what: "hero / social-card image generation",
  },
} as const satisfies Record<string, ModelTierSpec>;

export type ModelTier = keyof typeof MODEL_TIERS;

/**
 * Resolve the tiers an operator script spends on, for checkModelDrift().
 *
 * Deliberately the ONLY way a script gets these strings. A script that built
 * the pairs by hand could name a tier it does not use, or - the 2026-09-02
 * shape - report the one tier it remembered while a second went unchecked.
 */
export function resolveOperatorModels(
  tiers: readonly ModelTier[],
): ModelResolution[] {
  if (tiers.length === 0) {
    throw new Error(
      "resolveOperatorModels: name at least one tier. A script that spends AI " +
        "and declares no tier is the thing the guard exists to catch (US-3184).",
    );
  }
  const out = tiers.map((tier) => {
    const spec = MODEL_TIERS[tier];
    return {
      tier,
      env: spec.env,
      resolved: resolvingTier(spec.resolve),
      expected: spec.codeDefault,
    };
  });
  // ARM the check only after resolving, so this call cannot trip its own guard.
  // From here on any OTHER tier this process resolves throws rather than
  // spending on a model the banner never mentioned.
  declaredTiers = new Set(tiers);
  return out;
}

/** The exported resolver each tier routes through, by name, for guard tests. */
export const MODEL_TIER_RESOLVERS: Readonly<Record<ModelTier, string>> = {
  default: "getDefaultModel",
  lightweight: "getLightweightModel",
  sizeEstimate: "getSizeEstimateModel",
  platformVariant: "getPlatformVariantModel",
  photoQa: "getPhotoQaModel",
  gradingComposite: "getGradingCompositeModel",
  image: "getDefaultImageModel",
};

// Content-generation model, resolved per content KIND so an operator can route
// low-stakes short-form (social, email) to the cheaper model while keeping
// authority long-form (blog, refresh) on the default. `content` is the #1 AI
// spend slice.
//
// ⚠ CORRECTED 2026-09-08 (US-3149). This line used to say content "is
// OUTPUT-bound, so prompt caching can't help it — the model tier is the only
// lever", and that was measurably wrong in a way that cost the most of any
// single claim in this file. The 30-day ledger to 2026-09-08 put content at
// $55.84 of a $98.38 bill across 738 calls, at 5,488 median INPUT tokens each
// with a cache hit rate of ZERO. Output-bound it may be, but 4 MTok of input
// was still being re-billed at full rate every month. Caching could not help it
// because buildSystemPrompt returned one uncached string with the volatile
// history index sitting in the middle of it - a layout problem, not a property
// of the workload. The tier was never the only lever.
//
// Config-driven via CONTENT_MODEL_<KIND> Coolify vars;
// the DEFAULT for every kind is getDefaultModel(), so behavior is UNCHANGED
// until a var is set. An unknown/typo'd override is refused (warn + fall back)
// so a bad env value can't take content generation down.
export type ContentKind = "blog" | "refresh" | "email" | "social";

// Models an operator may route content to. Broader than the grading allowlist
// (content isn't reproducibility-sensitive) but still gated so a typo can't
// silently break generation. Mirrors the current + prior default/lightweight ids.
const CONTENT_MODEL_ALLOWLIST: ReadonlySet<string> = new Set([
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  DEFAULTS.model,
  DEFAULTS.lightweightModel,
]);

/**
 * Is this a model an operator may route non-grading generation to?
 *
 * US-3305: this set was only ever consulted for CONTENT_MODEL_<KIND> env vars,
 * so the routes that take a model NAME OUT OF A REQUEST BODY (admin-ads
 * /generate, content blog/social/topics generate) passed whatever string
 * arrived straight into messages.create. Same question, same answer, one set.
 *
 * Deliberately NOT the grading allowlist: that one gates reproducibility and a
 * model joins it by passing the eval gate. This one only has to keep a typo or
 * a hand-rolled request from choosing what gets billed.
 */
export function isAllowedContentModel(model: string): boolean {
  return CONTENT_MODEL_ALLOWLIST.has(model.trim());
}

/** The set as a stable sorted array, for error messages that must name it. */
export function allowedContentModels(): string[] {
  return [...CONTENT_MODEL_ALLOWLIST].sort();
}

/**
 * Validate a model name that arrived in a request body (US-3305).
 *
 * Returns the model to use (undefined = "caller named none, use the default")
 * or the 400 message. The message NAMES the allowed set, because "invalid
 * model" sends an operator to the source to find out what the set is.
 *
 * Refusing rather than falling back to the default on purpose: a caller who
 * asked for a specific model and silently got a different one is the same class
 * of invisible substitution this story exists to remove.
 */
export function validateRequestedModel(
  raw: unknown,
):
  | { ok: true; model: string | undefined }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, model: undefined };
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: `model must be a string naming one of: ${
        allowedContentModels().join(", ")
      }`,
    };
  }
  const model = raw.trim();
  if (!model) return { ok: true, model: undefined };
  if (!isAllowedContentModel(model)) {
    return {
      ok: false,
      error: `model "${model}" is not allowed; choose one of: ${
        allowedContentModels().join(", ")
      }`,
    };
  }
  return { ok: true, model };
}

/**
 * The same set, as an array, for the US-3151 guard that every model an operator
 * can route content to is still sent output_config.format. Exported rather than
 * duplicated in the test so adding a model here cannot leave the guard behind.
 */
export const CONTENT_MODEL_ALLOWLIST_FOR_TESTS: readonly string[] = [
  ...CONTENT_MODEL_ALLOWLIST,
];

export function getContentModel(kind: ContentKind): string {
  const envName = `CONTENT_MODEL_${kind.toUpperCase()}`;
  const override = Deno.env.get(envName)?.trim();
  if (override) {
    if (CONTENT_MODEL_ALLOWLIST.has(override)) return override;
    console.warn(
      `[ai-config] ${envName}="${override}" is not a known content model — ` +
        `falling back to the default content model (${getDefaultModel()}).`,
    );
  }
  return getDefaultModel();
}

export function getAiTimeoutMs(): number {
  return readNumber("AI_TIMEOUT_MS", DEFAULTS.timeoutMs);
}

export function getAiMaxRetries(): number {
  return readNumber("AI_MAX_RETRIES", DEFAULTS.maxRetries);
}

// Non-grading AI flows (extraction, content, reconcile) call this to pick up an
// optional sampling temperature. As of the move to Sonnet 5 (the current default
// model) it ALWAYS returns undefined: Sonnet 5 / Opus 4.6+ / Fable REMOVED the
// sampling parameters and reject `temperature` with a 400 ("temperature is
// deprecated for this model"). Every call site spreads this conditionally
// (`...(temperature !== undefined ? { temperature } : {})`), so returning
// undefined here makes those spreads no-ops and the models use their own default
// decoding. Kept as a function (rather than ripping out ~25 call sites) so the
// knob can be reinstated model-aware if a temperature-accepting model is ever
// routed here again. The legacy AI_TEMPERATURE env var is intentionally ignored.
export function getAiTemperature(): number | undefined {
  return undefined;
}

// ⚠️ US-2035: READ THIS BEFORE TRUSTING THE TEMPERATURE PATH BELOW.
//
// This block used to assert that grading "ALWAYS uses a low temperature,
// defaulting to 0 (fully greedy decoding)". That is FALSE on the shipping path
// and has been since grading moved to an effort-based model:
//
//   DEFAULTS.model is "claude-sonnet-5" → modelUsesEffort() is true →
//   gradingSamplingParams() returns { output_config: { effort } } and NO
//   temperature → getGradingTemperature() is never called.
//
// So on the default model, getGradingTemperature(), GRADING_DEFAULT_TEMPERATURE,
// GRADING_MAX_TEMPERATURE and the whole clamping apparatus are DEAD CODE, and
// grading runs at the model's own non-greedy decoding. A regrade of identical
// photos can return a different score.
//
// The original US-481 intent below still stands as INTENT — a certified score
// backing a public "standardized" value prop should be reproducible. But intent
// is not enforcement, and nothing here enforces it today:
//   - no greedy decoding on the default model (this block);
//   - no measurement — grading-reliability.ts implements the self-consistency
//     math but has ZERO non-test callers, so it never observes live grades;
//   - no gate — nothing fails or flags when two grades of one input diverge.
//
// Whether run-to-run variance is ACCEPTABLE is a product/trust decision, not an
// engineering one, and it is open (US-2035 AC1). Do not "fix" this by pinning a
// temperature: effort-based models reject `temperature` with a 400 (US-1033).
// The remedy, if determinism is still the promise, is a self-consistency check
// (grade twice, compare, flag divergence) — not this knob.
//
// The code below is retained, unchanged, for the legacy Sonnet 4.x / Haiku path
// where temperature IS still accepted. It is correct there and only there.
//
// An operator MAY raise it via GRADING_AI_TEMPERATURE (clamped to [0, 0.2]) if a
// documented experiment shows a higher value improves accuracy without harming
// self-consistency — the cap keeps any non-zero choice within a reproducible
// band. Always returns a number (never undefined) so the SDK default of 1.0 can
// never apply to grading ON THAT LEGACY PATH.
export const GRADING_DEFAULT_TEMPERATURE = 0;
export const GRADING_MAX_TEMPERATURE = 0.2;

export function getGradingTemperature(): number {
  const raw = Deno.env.get("GRADING_AI_TEMPERATURE");
  if (!raw) return GRADING_DEFAULT_TEMPERATURE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return GRADING_DEFAULT_TEMPERATURE;
  return Math.max(0, Math.min(GRADING_MAX_TEMPERATURE, parsed));
}

// US-1033: newer models (Sonnet 5, Opus 4.6/4.7/4.8, Fable/Mythos) REMOVED the
// sampling parameters — sending `temperature`/`top_p`/`top_k` returns a 400.
// They steer reasoning depth with output_config.effort instead. So every AI call
// must be model-family-aware: effort-based models get { output_config: { effort } }
// and NO temperature; older Sonnet 4.x/Haiku keep the low-temperature path.
// Without this, routing to Sonnet 5 (the current default) 400s every call —
// this is what surfaced as `[flipdesk-ai] extraction failed: 400 ... temperature
// is deprecated for this model`.
//
// ── US-3305: A RULE, NOT A PREFIX LIST ───────────────────────────────────────
//
// This used to be six startsWith() calls, and claude-opus-5 was not one of
// them. Opus 5 takes effort low..max, so any model variable pointed at it fed
// effortParams / outputConfigParams a model they classified as effort-free and
// every call went out with NO effort, running at the model's own default. The
// call succeeds. Nothing logs. A dropped parameter looks exactly like a
// parameter nobody set, which is the whole reason it survived a release.
//
// A list has to be edited for every new id, and the edit is invisible when it
// is forgotten. The naming already carries the answer, so the rule below reads
// it: within a family, effort arrived at a known generation and every later
// generation keeps it. It answers "yes" for claude-opus-5-1, claude-opus-6 and
// claude-sonnet-6 with nobody touching this file.
//
// Where it CANNOT know - a family this build has never seen, or a Haiku newer
// than any that has been checked - it says "unknown" and modelUsesEffort logs
// it once, loudly, rather than quietly answering "no". It still returns false
// there, because the two errors are not priced the same: a wrong "yes" 400s
// every call for that feature, a wrong "no" only costs the setting. The log is
// what makes the second one findable.
//
// Thresholds, from the Anthropic model documentation (read 2026-09-10):
//   opus    effort from 4.5 (4.5 is low/medium/high only; 4.6+ add xhigh/max)
//   sonnet  effort from 4.6; Sonnet 4.5 and older reject it
//   haiku   no released Haiku accepts it - 4.5 returns an error
//   fable   every released generation (5.0+), thinking is always on
//   mythos  same surface as fable
//
// ⚠ SONNET 4.6 CHANGED ANSWER HERE, from false to true. It does accept effort;
// the old list said otherwise. The visible consequence is gradingSamplingParams
// ("claude-sonnet-4-6"), which now returns { output_config: { effort } } rather
// than { temperature: 0 }. Sonnet 4.6 is not the default and is retained only
// so grades produced on the prior default stay re-gradable - but a re-grade of
// one of those now runs at the model's own decoding rather than greedy. That is
// the same non-determinism the US-2035 block above documents for every other
// effort model; if it ever needs to NOT be true for grading, the place to say
// so is gradingSamplingParams, not a knowingly-wrong answer about the API.
export type EffortSupport = "yes" | "no" | "unknown";

interface EffortFamilyRule {
  /** First [major, minor] in this family that accepts effort, or null if none does yet. */
  takesEffortFrom: readonly [number, number] | null;
  /** Newest [major, minor] this build has actually checked. Only consulted when the above is null. */
  classifiedThrough: readonly [number, number];
}

const EFFORT_BY_FAMILY: Readonly<Record<string, EffortFamilyRule>> = {
  opus: { takesEffortFrom: [4, 5], classifiedThrough: [5, 0] },
  sonnet: { takesEffortFrom: [4, 6], classifiedThrough: [5, 0] },
  haiku: { takesEffortFrom: null, classifiedThrough: [4, 5] },
  fable: { takesEffortFrom: [5, 0], classifiedThrough: [5, 1] },
  mythos: { takesEffortFrom: [5, 0], classifiedThrough: [5, 1] },
};

/** claude-<family>-<major>[-<minor>][-<datestamp>]: the naming since Claude 4.5. */
const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/;

function atLeast(
  v: readonly [number, number],
  min: readonly [number, number],
): boolean {
  return v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]);
}

/**
 * Does this model accept output_config.effort: yes, no, or not knowable here?
 *
 * Exported so a test can assert the third answer exists at all: "unknown"
 * collapsing into "no" is precisely the failure this story is about.
 */
export function classifyEffortSupport(model: string): EffortSupport {
  const id = model.trim().toLowerCase();

  // Pre-4.5 ids put the generation BEFORE the family (claude-3-5-sonnet-...,
  // claude-2-1). None of them accept effort and none ever will: the naming
  // itself dates them, so this is a rule and not a list of legacy ids.
  if (/^claude-\d/.test(id)) return "no";

  const m = MODEL_ID_PATTERN.exec(id);
  if (!m) return "unknown";
  const rule = EFFORT_BY_FAMILY[m[1] ?? ""];
  if (!rule) return "unknown";

  const version: [number, number] = [Number(m[2]), Number(m[3] ?? 0)];
  if (rule.takesEffortFrom) {
    return atLeast(version, rule.takesEffortFrom) ? "yes" : "no";
  }
  // No generation of this family takes effort yet. Anything at or below what
  // was actually checked is a confident no; anything newer is a guess.
  return atLeast(version, [
    rule.classifiedThrough[0],
    rule.classifiedThrough[1] + 1,
  ])
    ? "unknown"
    : "no";
}

const warnedUnclassifiedModels = new Set<string>();

export function modelUsesEffort(model: string): boolean {
  const verdict = classifyEffortSupport(model);
  if (verdict !== "unknown") return verdict === "yes";

  const id = model.trim().toLowerCase();
  if (!warnedUnclassifiedModels.has(id)) {
    warnedUnclassifiedModels.add(id);
    console.error(
      `[ai-config] "${model}" is not a model this build has classified for ` +
        `output_config.effort. Treating it as NOT taking effort, which is the ` +
        `safe direction (a wrong yes returns a 400 on every call) but may be ` +
        `silently dropping the parameter - the exact shape of US-3305. ` +
        `Classify its family in EFFORT_BY_FAMILY, lib/ai-config.ts.`,
    );
  }
  return false;
}

/** Test seam: let a test observe the warn-once behaviour more than once. */
export function resetEffortWarningsForTests(): void {
  warnedUnclassifiedModels.clear();
}

// Effort level for grading on effort-based models. Low keeps the bounded
// per-image/composite task reproducible + cheap; an operator may raise it via
// GRADING_AI_EFFORT (e.g. to "medium" if an eval shows it improves small-defect
// recall). Clamped to the supported set. Typed as the SDK's effort literal union.
export type GradingEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const GRADING_DEFAULT_EFFORT: GradingEffort = "low";
const GRADING_EFFORTS: ReadonlySet<string> = new Set<GradingEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function getGradingEffort(): GradingEffort {
  const raw = Deno.env.get("GRADING_AI_EFFORT")?.trim().toLowerCase();
  return raw && GRADING_EFFORTS.has(raw)
    ? (raw as GradingEffort)
    : GRADING_DEFAULT_EFFORT;
}

// ── Effort for NON-grading calls (US-3146) ───────────────────────────────────
//
// THE DEFAULT IS NOT A CHOICE ANYBODY MADE. Sonnet 5 runs adaptive thinking,
// and omitting output_config means effort `high`. Measured on production over
// 2026-08-09..09-08 (US-3145): 39 of 45 messages.create sites in this service
// send no output_config at all, so every one of them buys the deliberation
// depth of a hard reasoning problem for jobs like "read this care label into a
// fixed schema". Thinking bills as OUTPUT tokens, which is why the profile's
// out/call column is the thing this moves.
//
// ⚠ THIS IS NOT gradingSamplingParams AND MUST NOT BECOME IT. Grading has its
// own effort knob (GRADING_AI_EFFORT), its own allowlist, and a prompt-version
// lifecycle that attributes a grade to the exact configuration that produced
// it. A shared helper reaching into the grading path would let a per-feature
// env var move grades with no shadow compare and no version suffix. The grading
// call sites deliberately do not use anything below.
export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";

const AI_EFFORTS: ReadonlySet<string> = new Set<AiEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Turn a feature slug into its env var name: `catalog_extract` ->
 * `AI_EFFORT_CATALOG_EXTRACT`. Exported so a test can assert the mapping rather
 * than restate it, and so an operator can be told the exact name to set.
 */
export function effortEnvVar(feature: string): string {
  return `AI_EFFORT_${feature.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * The effort for one feature: the AI_EFFORT_<FEATURE> override if it names a
 * supported level, else the fallback the call site chose.
 *
 * Per-feature rather than global, for the same reason getSizeEstimateModel and
 * getPhotoQaModel are separate knobs: a bad week on ONE feature has to be
 * rollable without moving every other caller, and the reason for each choice
 * has to stay attached to the thing it justified. A typo'd value falls back
 * rather than throwing, because a bad env var must not take a feature down.
 */
export function getFeatureEffort(feature: string, fallback: AiEffort): AiEffort {
  const raw = Deno.env.get(effortEnvVar(feature))?.trim().toLowerCase();
  return raw && AI_EFFORTS.has(raw) ? (raw as AiEffort) : fallback;
}

/**
 * Spread into a messages.create body:
 *   ...effortParams(model, "tag_ocr", "low"),
 *
 * Returns `{}` on any model that does not take output_config.effort, which is
 * what makes this safe to add everywhere. Haiku 4.5 is the case that matters:
 * it REJECTS `effort`, and US-2924 routed size_estimate and photo_qa to it, so
 * on those two the helper is deliberately a no-op today and becomes live only
 * if they are ever routed back to an effort-taking model.
 *
 * ⚠ IT DOES NOT MERGE. A call site that already builds its own output_config
 * (a structured-output `format`, say) must compose the two itself rather than
 * spreading both and letting the second silently win. Only ai-grading.ts does
 * that today, and it does not use this helper.
 */
export function effortParams(
  model: string,
  feature: string,
  fallback: AiEffort,
): { output_config: { effort: AiEffort } } | Record<never, never> {
  if (!modelUsesEffort(model)) return {};
  return { output_config: { effort: getFeatureEffort(feature, fallback) } };
}

/**
 * Effort AND a structured-output schema, in one output_config (US-3151).
 *
 * ⚠ THIS EXISTS BECAUSE SPREADING BOTH SEPARATELY IS A SILENT BUG. Writing
 *     ...effortParams(model, "content_blog", "medium"),
 *     output_config: { format: { type: "json_schema", schema } },
 * compiles, runs, and drops the effort on the floor - the second key wins and
 * nothing says so. There is one object; it is built here.
 *
 * The schema makes a malformed reply impossible rather than requested. On
 * production, 349 of 402 content-scheduler errors in the 30 days to 2026-09-08
 * were the model returning JSON the hand-parser could not read.
 *
 * ⚠ NO `name` KEY INSIDE format. output_config.format accepts only
 * { type, schema }; anything else returns a 400 ("output_config.format.name:
 * Extra inputs are not permitted") and fails every call. That cost the grading
 * path a debugging session already - see ai-provider-anthropic.ts.
 *
 * On a model without effort, the schema still goes out on its own: structured
 * outputs and effort are independent features, and Haiku takes the first.
 */
export function outputConfigParams(
  model: string,
  feature: string,
  fallback: AiEffort,
  schema: unknown,
): { output_config: Record<string, unknown> } {
  return {
    output_config: {
      ...(modelUsesEffort(model)
        ? { effort: getFeatureEffort(feature, fallback) }
        : {}),
      format: { type: "json_schema", schema },
    },
  };
}

// Per-call sampling knobs for grading, model-family-aware (US-1033). Spread into
// the messages.create body in place of a hardcoded `temperature`.
export type GradingSamplingParams =
  | { temperature: number }
  | { output_config: { effort: GradingEffort } };

export function gradingSamplingParams(model: string): GradingSamplingParams {
  if (modelUsesEffort(model)) {
    return { output_config: { effort: getGradingEffort() } };
  }
  return { temperature: getGradingTemperature() };
}

export function isCachingEnabled(): boolean {
  return readBool("AI_ENABLE_CACHING", DEFAULTS.enableCaching);
}

// The env-var fallback for the review threshold (US-331), used when the
// settings registry has no row (fresh DB) or is unreadable. Clamped to (0, 1].
function reviewConfidenceEnvFallback(): number {
  const raw = Number(Deno.env.get("GRADING_REVIEW_CONFIDENCE_THRESHOLD"));
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
}

// Confidence below which a grade is routed to human review. US-884: now read
// through the DB-backed settings registry (key `grading_review_confidence_
// threshold`) so the calibration report's recommended operating point can be
// applied WITHOUT a deploy; the env var (US-331) is the fallback default.
// Synchronous (getSettingSync serves the cached value + warms in the
// background) so the existing sync call sites are unchanged. Clamped to (0, 1]
// so a bad stored value can never disable review.
export function reviewConfidenceThreshold(): number {
  const fallback = reviewConfidenceEnvFallback();
  const raw = getSettingSync<number>(
    "grading_review_confidence_threshold",
    fallback,
  );
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

/**
 * US-1622 / C9: re-derive whether a grade needs human review from its EFFECTIVE
 * confidence after all post-composite adjustments. Two invariants:
 *   • a grade already flagged stays flagged — provenance boosts never un-gate a
 *     grade (confidence is never "raised out of" review post-composite);
 *   • a grade whose effective confidence ended below the review threshold is
 *     forced to review, even if no single earlier event set the flag (e.g. a
 *     lone verification-discrepancy shave).
 * Pure, so the gate invariant is unit-tested independent of the pipeline.
 */
export function reconcileNeedsReview(
  priorNeedsReview: boolean,
  effectiveConfidence: number,
  threshold: number = reviewConfidenceThreshold(),
): boolean {
  return priorNeedsReview || effectiveConfidence < threshold;
}

let anthropicClient: Anthropic | null = null;

// US-414: route EVERY non-streaming messages.create through the process-wide
// limiter (global concurrency cap + daily volume ceiling + retry.ts backoff),
// in ONE place so every current and future caller is bounded — no per-call-site
// wiring to forget. We disable the SDK's own per-call retries (maxRetries: 0)
// so retry.ts is the single retry authority (no double-retry on a 429).
//
// Streaming calls are bypassed: the SSE content flows (messages.stream() and
// create({ stream: true })) are long-lived single calls, not the concurrency
// spike the audit flagged, and wrapping a stream in await/retry would break it.
function applyAiLimiter(client: Anthropic): Anthropic {
  // Treat messages.create loosely here ONLY to wrap it — callers still see the
  // fully-typed Anthropic client (this returns `client: Anthropic`), so no call
  // site changes. Avoids depending on the SDK's overloaded create() signature.
  const messages = client.messages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
  const rawCreate = messages.create.bind(messages);

  messages.create = (...args: unknown[]) => {
    const body = args[0] as
      | { stream?: boolean; model?: string; system?: unknown; messages?: unknown }
      | undefined;
    // Streaming → bypass the limiter (don't await/retry a stream).
    if (body?.stream) return rawCreate(...args);
    const options = (args[1] as Record<string, unknown> | undefined) ?? {};
    const rest = args.slice(2);
    // US-894: capture token spend for any feature-tagged call (opt-in via
    // enterAiFeature). No tag → record nothing, so the grading pipeline (which
    // logs its own per-grade rows) is never double-counted.
    const featureCtx = currentAiFeature();
    return runAiCall(async () => {
      const startedAt = Date.now();
      const result = await (rawCreate(
        body,
        { ...options, maxRetries: 0 },
        ...rest,
      ) as Promise<unknown>);
      if (featureCtx) {
        void captureAiUsage(featureCtx, body, result, Date.now() - startedAt);
      }
      return result;
    });
  };
  return client;
}

// US-894: best-effort, fire-and-forget recording of one Anthropic call into the
// ai_usage_events ledger. Dynamically imports lib/ai-usage.ts (which pulls in
// the supabase client) so this module stays import-safe for unit tests that
// never make a real call. Never throws.
async function captureAiUsage(
  ctx: { feature: string; userId: string | null },
  body: { model?: string; system?: unknown; messages?: unknown } | undefined,
  result: unknown,
  latencyMs: number,
): Promise<void> {
  try {
    const usage = (result as { usage?: unknown } | null)?.usage;
    if (!usage) return;
    const model = body?.model ??
      (result as { model?: string } | null)?.model ?? "unknown";
    const { toAiTokenUsage, recordAiCall, hashPrompt } = await import(
      "./ai-usage.ts"
    );
    await recordAiCall({
      feature: ctx.feature,
      userId: ctx.userId,
      usage: toAiTokenUsage(model, usage as Anthropic.Usage),
      latencyMs,
      promptHash: hashPrompt({
        system: body?.system,
        messages: body?.messages,
        model,
      }),
    });
  } catch (e) {
    console.warn(
      `[ai-config] usage capture failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = applyAiLimiter(
      new Anthropic({
        apiKey: getAnthropicApiKey(),
        timeout: getAiTimeoutMs(),
        maxRetries: getAiMaxRetries(),
      }),
    );
  }
  return anthropicClient;
}
