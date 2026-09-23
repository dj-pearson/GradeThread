// Where AnthropicProvider puts a caller's AiCallContext.
//
// ai-config's limiter wrapper attributes spend by reading currentAiFeature(),
// the AsyncLocalStorage scope, and nothing else. The provider used to pass the
// context as an SDK OPTION (`aiFeatureContext`) on both the plain and the
// streamed call: a key the wrapper never reads, forwarded to the SDK as an
// unknown request option, recording nothing. The plain call now runs inside
// that scope; the streamed call, which the wrapper never sees, refuses a
// context rather than dropping its usage row.
//
//   deno test --allow-env --allow-read src/tests/ai-provider-feature-context_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { getAnthropicClient } from "../lib/ai-config.ts";
import { currentAiFeature } from "../lib/ai-feature-context.ts";
import { AnthropicProvider } from "../lib/ai-provider-anthropic.ts";
import type { AiMessageRequest } from "../lib/ai-provider.ts";

// Both SDK entry points are stubbed per call, so this key never reaches a network.
if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

const REQUEST: AiMessageRequest = {
  model: "claude-test",
  maxTokens: 16,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};
const CONTEXT = { feature: "ads", userId: "00000000-0000-0000-0000-000000000001" };

interface Call {
  via: "create" | "stream";
  args: unknown[];
  feature: unknown;
}

/** Replace both SDK entry points for one call and record what they received. */
async function capture(fn: () => Promise<unknown>): Promise<{ calls: Call[]; error?: unknown }> {
  const surface = getAnthropicClient().messages as unknown as {
    create: (...args: unknown[]) => unknown;
    stream: (...args: unknown[]) => unknown;
  };
  const originalCreate = surface.create;
  const originalStream = surface.stream;
  const calls: Call[] = [];
  const reply = {
    content: [{ type: "text", text: "ok" }],
    model: "claude-test",
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  surface.create = (...args: unknown[]) => {
    calls.push({ via: "create", args, feature: currentAiFeature() });
    return Promise.resolve(reply);
  };
  surface.stream = (...args: unknown[]) => {
    calls.push({ via: "stream", args, feature: currentAiFeature() });
    return {
      on() {
        return this;
      },
      finalMessage: () => Promise.resolve(reply),
    };
  };
  try {
    await fn();
    return { calls };
  } catch (error) {
    return { calls, error };
  } finally {
    surface.create = originalCreate;
    surface.stream = originalStream;
  }
}

Deno.test("plain call: the context is in the wrapper's scope, not in the SDK options", async () => {
  const provider = new AnthropicProvider();
  const { calls, error } = await capture(() => provider.complete(REQUEST, CONTEXT));
  assertEquals(error, undefined);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].via, "create");
  assertEquals(calls[0].feature, CONTEXT, "currentAiFeature() is what captureAiUsage records");
  assertEquals(calls[0].args.length, 1, `no options argument: ${JSON.stringify(calls[0].args[1])}`);
});

Deno.test("plain call with no context: no scope is invented", async () => {
  const provider = new AnthropicProvider();
  const { calls } = await capture(() => provider.complete(REQUEST));
  assertEquals(calls[0].feature, undefined);
  assertEquals(calls[0].args.length, 1);
});

Deno.test("streamed call: a context is refused before anything is sent", async () => {
  const provider = new AnthropicProvider();
  const { calls, error } = await capture(() =>
    provider.complete({ ...REQUEST, onFirstToken: () => {} }, CONTEXT)
  );
  assert(error instanceof Error, "expected a rejection");
  assert(error.message.includes("cannot record usage"), error.message);
  assertEquals(calls, [], "the stream must not start");
});

Deno.test("streamed call with no context: only maxRetries goes to the SDK", async () => {
  const provider = new AnthropicProvider();
  let fired = 0;
  const { calls, error } = await capture(() =>
    provider.complete({ ...REQUEST, onFirstToken: () => fired++ })
  );
  assertEquals(error, undefined);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].via, "stream");
  assertEquals(calls[0].args[1], { maxRetries: 0 });
  assertEquals(fired, 0, "the stub emits no events");
});

Deno.test("the adapter no longer names the dead aiFeatureContext option in code", async () => {
  const src = await Deno.readTextFile(new URL("../lib/ai-provider-anthropic.ts", import.meta.url));
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  assertEquals(code.filter((l) => l.includes("aiFeatureContext")), []);
});
