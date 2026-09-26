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
//
// One path cannot inherit the wrapper: a STREAMED call (US-3345's staggered
// first photo), which the wrapper passes through unbounded. streamed() below
// therefore calls runAiCall itself, so it is bounded the same way.

import { anthropicBreaker } from "./grading-availability.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./ai-config.ts";
import { withAiFeature } from "./ai-feature-context.ts";
import { runAiCall } from "./ai-limiter.ts";
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

    // The feature context goes where ai-config's wrapper reads it: the
    // AsyncLocalStorage scope that currentAiFeature() returns, which is what
    // makes captureAiUsage write the ai_usage_events row. It used to ride on
    // the SDK options as `aiFeatureContext`, a key the wrapper never reads, so
    // it reached the SDK as an unknown request option and recorded nothing.
    const create = () =>
      (client.messages.create as unknown as (b: unknown) => Promise<Anthropic.Message>)(body);
    // US-3530: every call goes through one shared breaker, so an outage fails
    // fast instead of every call waiting out its timeout and retries, and
    // submits can refuse before charging (grading-availability.ts).
    const onFirstToken = request.onFirstToken;
    const response: Anthropic.Message = await anthropicBreaker().execute(() =>
      onFirstToken
        ? this.streamed(client, body, onFirstToken, context)
        : context
        ? withAiFeature(context, create)
        : create()
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

  /**
   * US-3345: the same request, streamed, so the caller can learn when
   * generation began. Only the grading fan-out's FIRST call takes this path,
   * and only with GRADING_CACHE_STAGGER on: a prompt-cache entry is readable
   * once the request writing it has begun streaming, which is the moment
   * photos 2..N can be released to read it.
   *
   * ai-config's limiter wrapper deliberately lets streaming calls through
   * unbounded (it cannot await or retry an SSE body it hands back), so this
   * call takes the limiter ITSELF: runAiCall gives it the same daily ceiling,
   * concurrency slot and retry.ts backoff as the non-streamed calls beside it,
   * and maxRetries 0 keeps retry.ts the only retry authority. A retry re-runs
   * the whole stream; `onFirstToken` fires at most once across attempts.
   * Nothing is written to ai_usage_events here: the wrapper's captureAiUsage
   * never sees a stream. That matches the non-stream path for grading, which
   * records per-grade usage itself (recordAiUsage) and passes no feature
   * context. A caller that DOES pass one would lose its usage row silently, so
   * that is refused here, before anything is sent or spent.
   */
  private streamed(
    client: Anthropic,
    body: unknown,
    onFirstToken: () => void,
    context?: AiCallContext | null,
  ): Promise<Anthropic.Message> {
    if (context) {
      return Promise.reject(
        new Error(
          `[ai-provider] a streamed call cannot record usage for feature "${context.feature}"; ` +
            "stream only the grading fan-out, which passes no context",
        ),
      );
    }
    let fired = false;
    return runAiCall(async () => {
      const stream = (client.messages.stream as unknown as (
        b: unknown,
        o?: unknown,
      ) => {
        on: (event: "streamEvent", listener: () => void) => unknown;
        finalMessage: () => Promise<Anthropic.Message>;
      })(body, { maxRetries: 0 });
      stream.on("streamEvent", () => {
        if (fired) return;
        fired = true;
        onFirstToken();
      });
      return await stream.finalMessage();
    });
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
