import Anthropic from "@anthropic-ai/sdk";

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
// (currently 1.0). Returning a number clamps to [0, 1].
export function getAiTemperature(): number | undefined {
  const raw = Deno.env.get("AI_TEMPERATURE");
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
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

export function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: getAnthropicApiKey(),
      timeout: getAiTimeoutMs(),
      maxRetries: getAiMaxRetries(),
    });
  }
  return anthropicClient;
}
