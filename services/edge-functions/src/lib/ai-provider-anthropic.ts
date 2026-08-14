// US-2568: the Anthropic implementation of AiProvider.
//
// This is a TRANSLATION LAYER AND NOTHING ELSE. It wraps the client
// getAnthropicClient() already returns, so every guarantee that client carries
// is preserved by construction rather than re-implemented:
//
//   • the ai-limiter wrapper (US-414) — global concurrency, daily ceiling, retry
//   • the request timeout and maxRetries from ai-config
//   • the fire-and-forget captureAiUsage hook that writes ai_usage_events
//
// If this file ever grows behaviour of its own — a retry, a cache, a fallback —
// that behaviour is now invisible to the limiter, and the per-image calls that
// run under Promise.all stop being bounded. Put it in the limiter instead.

import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./ai-config.ts";
import {
  type AiCallContext,
  type AiContentBlock,
  type AiMessageRequest,
  type AiMessageResponse,
  type AiProvider,
  normalizeStopReason,
  normalizeUsage,
} from "./ai-provider.ts";

export const ANTHROPIC_PROVIDER_ID = "anthropic";

function toAnthropicContent(block: AiContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mediaType as Anthropic.Base64ImageSource["media_type"],
          data: block.base64,
        },
      };
    case "image_url":
      return { type: "image", source: { type: "url", url: block.url } };
  }
}

export class AnthropicProvider implements AiProvider {
  readonly id = ANTHROPIC_PROVIDER_ID;
  // US-1032: the grading pipeline depends on guaranteed schema-conformant JSON.
  readonly supportsSchema = true;

  async complete(
    request: AiMessageRequest,
    context?: AiCallContext | null,
  ): Promise<AiMessageResponse> {
    const client = getAnthropicClient();

    // A cache hint becomes cache_control. A provider without prompt caching
    // would simply drop it; here it is honoured, which is what amortizes the
    // static grading prompt across the 5-minute window (US-1067).
    const system: Anthropic.TextBlockParam[] | undefined = request.system?.map(
      (block) =>
        block.cache
          ? { type: "text", text: block.text, cache_control: { type: "ephemeral" } }
          : { type: "text", text: block.text },
    );

    const body = {
      model: request.model,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      // ⚠ `name` is DELIBERATELY NOT SENT. output_config.format accepts only
      // { type, schema }; any extra key returns a 400
      // ("output_config.format.name: Extra inputs are not permitted") and fails
      // every per-image analysis and the composite grade. The field exists on
      // AiJsonSchema for providers that require one — dropping it is this
      // adapter's job, not the caller's.
      ...(request.jsonSchema || request.effort
        ? {
          output_config: {
            ...(request.effort ? { effort: request.effort } : {}),
            ...(request.jsonSchema
              ? {
                format: {
                  type: "json_schema" as const,
                  schema: request.jsonSchema.schema,
                },
              }
              : {}),
          },
        }
        : {}),
      ...(system ? { system } : {}),
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content.map(toAnthropicContent),
      })),
    };

    // The feature context rides on the OPTIONS argument, which is how
    // ai-config's wrapper picks it up for captureAiUsage — passing it here keeps
    // the usage ledger populated exactly as the direct calls did.
    const response = await (client.messages.create as unknown as (
      b: unknown,
      o?: unknown,
    ) => Promise<Anthropic.Message>)(
      body,
      context ? { aiFeatureContext: context } : undefined,
    );

    // Concatenate every text block rather than taking the first. A single block
    // is the norm and was what the old call sites assumed, but a reply split
    // across two blocks would have silently lost its tail — a truncated JSON
    // body that fails to parse and reads as a model fault.
    const text = (response.content ?? [])
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      model: response.model ?? request.model,
      usage: normalizeUsage(response.usage),
      stopReason: normalizeStopReason(response.stop_reason),
      providerId: this.id,
    };
  }
}

let cached: AiProvider | null = null;

/**
 * The provider the grading path uses.
 *
 * A single named function, so swapping providers is one edit here plus a config
 * value — which is the whole point of US-2568 and the thing a second provider
 * would otherwise have to be threaded through 33 files to achieve.
 *
 * GRADING_AI_PROVIDER exists so the swap can be made without a deploy once a
 * second implementation lands. Today it accepts only "anthropic"; an unknown
 * value falls back rather than throwing, because a typo in an env var must not
 * take grading down.
 */
export function getGradingProvider(): AiProvider {
  if (cached) return cached;
  const configured = (Deno.env.get("GRADING_AI_PROVIDER") ?? "").trim().toLowerCase();
  if (configured && configured !== ANTHROPIC_PROVIDER_ID) {
    console.warn(
      `[ai-provider] GRADING_AI_PROVIDER="${configured}" is not implemented; ` +
        `using ${ANTHROPIC_PROVIDER_ID}.`,
    );
  }
  cached = new AnthropicProvider();
  return cached;
}

/** Test seam: swap the provider, and put it back. */
export function setGradingProviderForTests(provider: AiProvider | null): void {
  cached = provider;
}
