import {
  getAiTemperature,
  getAnthropicClient,
  getDefaultModel,
} from "./ai-config.ts";

// Low-level streaming primitive for the content module's live-into-the-editor
// features (US-251 SSE compose, US-252 section regen). Wraps the Anthropic
// streaming API and yields plain text deltas as they arrive, so the route
// handler can relay them over SSE without knowing SDK event shapes.
//
// We intentionally stream PROSE/HTML text — not the JSON envelope the batch
// generator (content-ai-blog.ts) uses — because partial JSON can't be inserted
// into the editor mid-stream. The prompts that feed this ask the model to emit
// the content directly.

export interface StreamTextInput {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

// Async generator of text deltas. Throws if the upstream errors; callers relay
// that as an SSE `error` event. Honors an AbortSignal so a client "Stop" tears
// the upstream request down instead of burning tokens.
export async function* streamAnthropicText(
  input: StreamTextInput,
): AsyncGenerator<string, void, unknown> {
  const client = getAnthropicClient();
  const model = input.model ?? getDefaultModel();
  const temperature = getAiTemperature();

  const stream = client.messages.stream(
    {
      model,
      max_tokens: input.maxTokens ?? 4096,
      ...(temperature !== undefined ? { temperature } : {}),
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    },
    input.signal ? { signal: input.signal } : undefined,
  );

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}
