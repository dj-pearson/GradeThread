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
