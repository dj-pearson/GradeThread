// US-2568: the grading path stays vendor-neutral, and a second provider stays
// one file away.
//
// The story is only real if it holds. An abstraction with no guard rots back:
// somebody needs one Anthropic-shaped field, imports the SDK "just here", and
// six months later the seam is decorative again — which is exactly how
// getAnthropicClient() ended up being the only construction site while 33 files
// still spoke the vendor's dialect.

import { assert, assertEquals } from "@std/assert";
import {
  type AiMessageRequest,
  type AiMessageResponse,
  type AiProvider,
  normalizeStopReason,
  normalizeUsage,
  ZERO_USAGE,
} from "../lib/ai-provider.ts";

const LIB = new URL("../lib/", import.meta.url);

async function read(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, LIB));
}

// ── The drift guard ────────────────────────────────────────────────────────

Deno.test("the grading path does not import the Anthropic SDK", async () => {
  // The measurable outcome of US-2568. ai-grading.ts is the module that earns
  // the money and the module that fails during a vendor incident.
  for (const file of ["ai-grading.ts", "grading-pipeline.ts", "ai-usage.ts"]) {
    const src = await read(file);
    assertEquals(
      /from "@anthropic-ai\/sdk"/.test(src),
      false,
      `${file} must not import @anthropic-ai/sdk — route the call through ` +
        `lib/ai-provider.ts instead. If a vendor-only field is genuinely needed, ` +
        `it belongs in the adapter (ai-provider-anthropic.ts), not here.`,
    );
  }
});

Deno.test("only the adapter constructs the vendor client", async () => {
  // getAnthropicClient() may be CALLED from one place only. A second caller on
  // the grading path is a second dialect, and the limiter guarantees stop being
  // uniform.
  const adapter = await read("ai-provider-anthropic.ts");
  assert(adapter.includes("getAnthropicClient()"));

  for (const file of ["ai-grading.ts", "grading-pipeline.ts"]) {
    const src = await read(file);
    const calls = [...src.matchAll(/getAnthropicClient\(\)/g)].filter((m) => {
      // Ignore prose. The name appears in comments explaining the seam.
      const lineStart = src.lastIndexOf("\n", m.index ?? 0) + 1;
      return !/^\s*(\/\/|\*)/.test(src.slice(lineStart, m.index));
    });
    assertEquals(calls.length, 0, `${file} must not construct the vendor client`);
  }
});

Deno.test("the grading path makes no direct messages.create call", async () => {
  for (const file of ["ai-grading.ts", "grading-pipeline.ts"]) {
    const src = await read(file);
    const calls = [...src.matchAll(/\.messages\.create\(/g)];
    assertEquals(calls.length, 0, `${file} must call the provider, not the SDK`);
  }
});

Deno.test("the cost ledger is typed on the neutral shape", async () => {
  // lib/ai-usage.ts typing on Anthropic.Usage was the tell that margin reporting
  // was welded to one vendor — a second provider's spend would have read as $0.
  const src = await read("ai-usage.ts");
  assert(!src.includes("Anthropic.Usage"));
  assert(src.includes('from "./ai-provider.ts"'));
  assert(
    src.includes("providerId"),
    "prices must be attributable to a provider, or two vendors' models collide",
  );
});

// ── The normalizers ────────────────────────────────────────────────────────

Deno.test("usage normalization accepts both the SDK shape and the neutral one", () => {
  assertEquals(
    normalizeUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 7,
    }),
    { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 7 },
  );
  assertEquals(
    normalizeUsage({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    }),
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  );
});

Deno.test("a missing or malformed usage object degrades the COST, never the grade", () => {
  // This runs on the paid path. A NaN here would poison the margin column or
  // fail the insert; zeros under-report visibly, which is recoverable.
  assertEquals(normalizeUsage(null), ZERO_USAGE);
  assertEquals(normalizeUsage(undefined), ZERO_USAGE);
  assertEquals(normalizeUsage({ input_tokens: "banana" }), ZERO_USAGE);
  assertEquals(normalizeUsage({ input_tokens: -5 }), ZERO_USAGE);
});

Deno.test("stop reasons from different vendors map onto one union", () => {
  assertEquals(normalizeStopReason("end_turn"), "end");     // Anthropic
  assertEquals(normalizeStopReason("stop"), "end");          // OpenAI
  assertEquals(normalizeStopReason("max_tokens"), "max_tokens");
  assertEquals(normalizeStopReason("length"), "max_tokens"); // OpenAI
  assertEquals(normalizeStopReason("content_filter"), "refusal");
  assertEquals(normalizeStopReason("something_new"), "other");
  assertEquals(normalizeStopReason(null), "other");
});

// ── A second provider is a file, not a refactor ────────────────────────────

/**
 * The proof AC6 asks for: a working provider that is not Anthropic, written
 * against nothing but the interface. If this compiles and satisfies callers,
 * a real second vendor is the same amount of work plus an HTTP call.
 */
class StubProvider implements AiProvider {
  readonly id = "stub";
  readonly supportsSchema = false;
  seen: AiMessageRequest | null = null;

  complete(request: AiMessageRequest): Promise<AiMessageResponse> {
    this.seen = request;
    return Promise.resolve({
      text: '{"ok":true}',
      model: request.model,
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "end",
      providerId: this.id,
    });
  }
}

Deno.test("a non-Anthropic provider satisfies the interface with no vendor types", async () => {
  const stub = new StubProvider();
  const out = await stub.complete({
    model: "stub-1",
    maxTokens: 128,
    system: [{ text: "grade this", cache: true }],
    jsonSchema: { name: "image_analysis", schema: { type: "object" } },
    messages: [{
      role: "user",
      content: [
        { type: "image", mediaType: "image/jpeg", base64: "AAAA" },
        { type: "text", text: "front" },
      ],
    }],
  });

  assertEquals(out.providerId, "stub");
  assertEquals(out.usage.cacheWriteTokens, 0);
  // The cache hint reached the provider, which is free to ignore it — that is
  // what makes prompt caching an optimisation rather than a requirement.
  assertEquals(stub.seen?.system?.[0].cache, true);
  // And the schema NAME survives on the request even though Anthropic drops it
  // on the wire, because OpenAI and Gemini both require one.
  assertEquals(stub.seen?.jsonSchema?.name, "image_analysis");
});

Deno.test("the adapter never sends the schema name — Anthropic 400s on it", async () => {
  // The bug this would have shipped: output_config.format accepts only
  // { type, schema }, and an extra key fails EVERY per-image analysis and the
  // composite grade with a 400. Caught in review; pinned here so it stays caught.
  const adapter = await read("ai-provider-anthropic.ts");
  const body = adapter.slice(adapter.indexOf("const body = {"), adapter.indexOf("// The feature context"));
  assert(
    !/name:\s*request\.jsonSchema\.name/.test(body),
    "the adapter must not put `name` inside output_config.format",
  );
  assert(/schema: request\.jsonSchema\.schema/.test(body));
});

Deno.test("the provider is swappable by config, and a bad value never breaks grading", async () => {
  const adapter = await read("ai-provider-anthropic.ts");
  assert(adapter.includes("GRADING_AI_PROVIDER"));
  assert(
    adapter.includes("console.warn") && adapter.includes("is not implemented"),
    "an unknown provider name must warn and fall back — a typo in an env var " +
      "must not take grading down",
  );
});
