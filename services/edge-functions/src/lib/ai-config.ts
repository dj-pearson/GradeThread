import Anthropic from "@anthropic-ai/sdk";
import { runAiCall } from "./ai-limiter.ts";

// Central reader for AI configuration. Values come from Coolify Team Shared
// Variables so every Pearson Media project flips together when a model or
// timeout changes. Each function falls back to a safe default so a missing
// var never breaks a deploy — only a missing API key does.

const DEFAULTS = {
  model: "claude-sonnet-4-6",
  lightweightModel: "claude-haiku-4-5-20251001",
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

// Model for the grading composite step — a text-only synthesis of the
// per-image vision results. Defaults to the vision model so behavior is
// unchanged unless an operator deliberately routes it to a cheaper model.
export function getGradingCompositeModel(): string {
  return Deno.env.get("GRADING_COMPOSITE_MODEL")?.trim() || getDefaultModel();
}

export function getAiTimeoutMs(): number {
  return readNumber("AI_TIMEOUT_MS", DEFAULTS.timeoutMs);
}

export function getAiMaxRetries(): number {
  return readNumber("AI_MAX_RETRIES", DEFAULTS.maxRetries);
}

// Returns undefined when the var is unset so the SDK applies its own default
// (currently 1.0). Returning a number clamps to [0, 1]. Used by the
// non-grading AI flows (extraction, content, reconcile) where some sampling
// variety is acceptable.
export function getAiTemperature(): number | undefined {
  const raw = Deno.env.get("AI_TEMPERATURE");
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
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

export function isCachingEnabled(): boolean {
  return readBool("AI_ENABLE_CACHING", DEFAULTS.enableCaching);
}

// Confidence below which a grade is routed to human review. Configurable
// (US-331) so the calibration report's recommended operating point can be
// applied without a code change. Defaults to 0.75. Clamped to (0, 1].
export function reviewConfidenceThreshold(): number {
  const raw = Number(Deno.env.get("GRADING_REVIEW_CONFIDENCE_THRESHOLD"));
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
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
    const body = args[0] as { stream?: boolean } | undefined;
    // Streaming → bypass the limiter (don't await/retry a stream).
    if (body?.stream) return rawCreate(...args);
    const options = (args[1] as Record<string, unknown> | undefined) ?? {};
    const rest = args.slice(2);
    return runAiCall(() =>
      rawCreate(body, { ...options, maxRetries: 0 }, ...rest) as Promise<unknown>
    );
  };
  return client;
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
