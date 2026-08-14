// US-2568: one seam between the grading path and whoever is generating tokens.
//
// THE PROBLEM THIS SOLVES. `getAnthropicClient()` in ai-config.ts is the only
// place the SDK is constructed, which looks like an abstraction until you notice
// it returns `Anthropic` — the concrete client. So 33 files call
// `client.messages.create()` against Anthropic's request and response shapes,
// and `lib/ai-usage.ts` typed its cost function on `Anthropic.Usage`, meaning
// the entire cost-per-grade and gross-margin dashboard was welded to one vendor.
// Adding a failover provider was a 33-file change on the revenue path.
//
// SCOPE IS DELIBERATELY THE REVENUE PATH ONLY. ai-grading.ts is what fails when
// Anthropic has an incident and what stops earning money; the newsletter,
// content and support generators stay on the SDK. Migrating everything would be
// a large change with most of its risk on code that can simply wait.
//
// This module is PURE — types plus normalizers, no client, no IO — so it stays
// import-safe for tests that never make a call.

/** A piece of a user message. Deliberately narrower than any vendor's union. */
export type AiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; base64: string }
  | { type: "image_url"; url: string };

/**
 * A system-prompt segment.
 *
 * `cache: true` asks the provider to cache this segment across calls. It is a
 * HINT, not a contract: a provider without prompt caching ignores it and the
 * call still succeeds, just more expensively. Modelling it as a hint rather than
 * a required capability is what keeps a second provider a config change instead
 * of a rewrite.
 */
export interface AiSystemBlock {
  text: string;
  cache?: boolean;
}

export interface AiMessage {
  role: "user" | "assistant";
  content: AiContentBlock[];
}

/**
 * A structured-output request: the reply must be JSON satisfying `schema`.
 *
 * Grading depends on this — US-1032 moved the pipeline onto guaranteed
 * schema-conformant JSON, and a provider that cannot honour it would silently
 * regress every grade to fence-stripping and parse failures. So `supportsSchema`
 * on the provider is how a caller finds out BEFORE it sends, rather than by
 * parsing a broken reply.
 */
export interface AiJsonSchema {
  /**
   * A label for the schema, for providers that require or accept one.
   *
   * ⚠ ANTHROPIC REJECTS IT. `output_config.format` accepts only
   * `{ type, schema }`, and any extra key comes back as a 400
   * ("output_config.format.name: Extra inputs are not permitted") which fails
   * every per-image analysis and the composite grade. The adapter therefore
   * DROPS this on the wire. It stays in the interface because OpenAI and Gemini
   * both require a schema name, and a second provider must not have to invent
   * one at the call site.
   */
  name: string;
  schema: Record<string, unknown>;
}

/**
 * How much reasoning to spend, where the provider exposes a dial for it.
 *
 * Anthropic's effort-based models take this inside output_config and reject a
 * top-level `temperature` alongside it; older models take temperature instead.
 * gradingSamplingParams (US-1033) already decides which — this just carries the
 * answer across the seam without the vendor's placement leaking into it.
 */
export type AiEffort = string;

export interface AiMessageRequest {
  model: string;
  system?: AiSystemBlock[];
  messages: AiMessage[];
  maxTokens: number;
  temperature?: number;
  jsonSchema?: AiJsonSchema;
  effort?: AiEffort;
}

/**
 * Token usage, normalized.
 *
 * `cacheWriteTokens` rather than Anthropic's `cache_creation_input_tokens`, and
 * every field non-optional with a zero default — a provider that reports no
 * cache numbers records zeros, which costs zero, rather than `undefined`
 * propagating into a NaN in the margin column.
 */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Why generation stopped, provider-neutral.
 *
 * `max_tokens` is called out separately from `other` because it is the one that
 * silently corrupts a grade: a truncated reply is invalid JSON, and before
 * structured output that surfaced as a parse failure rather than as "the model
 * ran out of room". Callers should be able to tell those apart.
 */
export type AiStopReason = "end" | "max_tokens" | "refusal" | "tool_use" | "other";

export interface AiMessageResponse {
  /** The concatenated text of the reply. Empty string, never null. */
  text: string;
  /** The model that actually answered — may differ from what was requested. */
  model: string;
  usage: AiUsage;
  stopReason: AiStopReason;
  /** Which provider produced this, for cost attribution. */
  providerId: string;
}

/** Who made the call, for the usage ledger. Mirrors ai-config's feature context. */
export interface AiCallContext {
  feature: string;
  userId: string | null;
}

export interface AiProvider {
  readonly id: string;
  /** False when the provider cannot guarantee schema-conformant JSON. */
  readonly supportsSchema: boolean;
  complete(
    request: AiMessageRequest,
    context?: AiCallContext | null,
  ): Promise<AiMessageResponse>;
}

/**
 * Coerce whatever a provider reports into AiUsage.
 *
 * Total, and total on purpose: this runs on the paid grading path, where a
 * malformed usage object must degrade the COST RECORD and never the grade. A
 * missing or non-finite field becomes 0, so the row is written and visibly
 * under-counts rather than failing the insert or poisoning the margin with NaN.
 */
export function normalizeUsage(raw: unknown): AiUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const n = (...keys: string[]): number => {
    for (const key of keys) {
      const v = Number(u[key]);
      if (Number.isFinite(v) && v >= 0) return v;
    }
    return 0;
  };
  return {
    inputTokens: n("inputTokens", "input_tokens", "prompt_tokens"),
    outputTokens: n("outputTokens", "output_tokens", "completion_tokens"),
    cacheReadTokens: n("cacheReadTokens", "cache_read_input_tokens"),
    cacheWriteTokens: n("cacheWriteTokens", "cache_creation_input_tokens"),
  };
}

/** Map a provider's stop reason onto the neutral union. */
export function normalizeStopReason(raw: unknown): AiStopReason {
  switch (String(raw ?? "").toLowerCase()) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
    case "complete":
      return "end";
    case "max_tokens":
    case "length":
      return "max_tokens";
    case "refusal":
    case "content_filter":
      return "refusal";
    case "tool_use":
      return "tool_use";
    default:
      return "other";
  }
}
