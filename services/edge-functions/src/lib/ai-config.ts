import Anthropic from "@anthropic-ai/sdk";
import { runAiCall } from "./ai-limiter.ts";
import { getSettingSync } from "./system-settings.ts";
import { currentAiFeature } from "./ai-feature-context.ts";

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

export function getDefaultModel(): string {
  return Deno.env.get("DEFAULT_AI_MODEL")?.trim() || DEFAULTS.model;
}

export function getLightweightModel(): string {
  return Deno.env.get("LIGHTWEIGHT_AI_MODEL")?.trim() || DEFAULTS.lightweightModel;
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
  return Deno.env.get("SIZE_ESTIMATE_AI_MODEL")?.trim() || getLightweightModel();
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
  return Deno.env.get("PLATFORM_VARIANT_AI_MODEL")?.trim() || getLightweightModel();
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
  return Deno.env.get("PHOTO_QA_AI_MODEL")?.trim() || getLightweightModel();
}

// US-853: image model for hero/social-card generation. Read from the shared
// config (DEFAULT_IMAGE_MODEL Coolify var) so it flips centrally; falls back to
// gpt-image-1. Never hardcode the model at the call site.
export function getDefaultImageModel(): string {
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
  const override = Deno.env.get("GRADING_COMPOSITE_MODEL")?.trim();
  if (override) {
    if (isAllowedGradingModel(override)) return override;
    console.warn(
      `[ai-config] GRADING_COMPOSITE_MODEL="${override}" is NOT on the grading ` +
        `allowlist — falling back to the default grading model. Add it to ` +
        `GRADING_MODEL_ALLOWLIST once qualified against the eval gate.`,
    );
  }
  return getDefaultModel();
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

// Content-generation model, resolved per content KIND so an operator can route
// low-stakes short-form (social, email) to the cheaper model while keeping
// authority long-form (blog, refresh) on the default. `content` is the #1 AI
// spend slice and is OUTPUT-bound, so prompt caching can't help it — the model
// tier is the only lever. Config-driven via CONTENT_MODEL_<KIND> Coolify vars;
// the DEFAULT for every kind is getDefaultModel(), so behavior is UNCHANGED
// until a var is set. An unknown/typo'd override is refused (warn + fall back)
// so a bad env value can't take content generation down.
export type ContentKind = "blog" | "refresh" | "email" | "social";

// Models an operator may route content to. Broader than the grading allowlist
// (content isn't reproducibility-sensitive) but still gated so a typo can't
// silently break generation. Mirrors the current + prior default/lightweight ids.
const CONTENT_MODEL_ALLOWLIST: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  DEFAULTS.model,
  DEFAULTS.lightweightModel,
]);

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
export function modelUsesEffort(model: string): boolean {
  const m = model.trim().toLowerCase();
  return (
    m.startsWith("claude-sonnet-5") ||
    m.startsWith("claude-opus-4-6") ||
    m.startsWith("claude-opus-4-7") ||
    m.startsWith("claude-opus-4-8") ||
    m.startsWith("claude-fable") ||
    m.startsWith("claude-mythos")
  );
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
