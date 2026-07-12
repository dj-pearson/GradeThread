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

// US-481: Grading must be REPRODUCIBLE — the same garment must not score
// differently on a re-grade or dispute. So grading (the per-image vision pass
// AND the composite synthesis) ALWAYS uses a low temperature, defaulting to 0
// (fully greedy decoding) regardless of whether AI_TEMPERATURE is set. This is
// deliberately decoupled from getAiTemperature(): a global AI_TEMPERATURE meant
// to add variety to copywriting must never leak nondeterminism into a graded,
// certified score that backs a public "standardized" value prop.
//
// An operator MAY raise it via GRADING_AI_TEMPERATURE (clamped to [0, 0.2]) if a
// documented experiment shows a higher value improves accuracy without harming
// self-consistency — the cap keeps any non-zero choice within a reproducible
// band. Always returns a number (never undefined) so the SDK default of 1.0 can
// never apply to grading.
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
