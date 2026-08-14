// US-894: AI spend attribution + cost helpers.
//   - ai-feature-context propagates the active feature across awaits.
//   - hashPrompt is stable + sensitive to the prompt.
//   - computeCostUsd prices tokens from the model table.
// Set dummy supabase env before importing (ai-usage/supabase load at init).
//   deno test --allow-env src/tests/ai-spend_test.ts
import { assertEquals, assertNotEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { enterAiFeature, withAiFeature, currentAiFeature } = await import(
  "../lib/ai-feature-context.ts"
);
const { hashPrompt, computeCostUsd } = await import("../lib/ai-usage.ts");

Deno.test("currentAiFeature is undefined with no context", () => {
  assertEquals(currentAiFeature(), undefined);
});

Deno.test("enterAiFeature tags the current async context across awaits", async () => {
  async function deepCall(): Promise<string | undefined> {
    await new Promise((r) => setTimeout(r, 1));
    return currentAiFeature()?.feature;
  }
  async function entry(): Promise<string | undefined> {
    enterAiFeature("autolister");
    return await deepCall();
  }
  // US-2379: enterWith() escapes into the CALLER's async context — that is the
  // whole point of it, and it means an unconfined call here leaks "autolister"
  // into whatever test the runner picks next. Under --shuffle that landed on
  // "currentAiFeature is undefined with no context", which then failed for a
  // reason that had nothing to do with it. Confining the call to a run() scope
  // keeps the assertion honest (enterWith still overrides the outer value and
  // still propagates across the await) without the leak.
  const tagged = await withAiFeature(
    { feature: "outer-scope", userId: null },
    () => entry(),
  );
  assertEquals(tagged, "autolister");
});

Deno.test("withAiFeature scopes the context to the callback", async () => {
  const inside = await withAiFeature(
    { feature: "content", userId: "u-1" },
    async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentAiFeature();
    },
  );
  assertEquals(inside?.feature, "content");
  assertEquals(inside?.userId, "u-1");
});

Deno.test("hashPrompt is stable for equal input and differs for different input", () => {
  const a = hashPrompt({ system: "grade this", messages: [1, 2] });
  const b = hashPrompt({ system: "grade this", messages: [1, 2] });
  const c = hashPrompt({ system: "grade THAT", messages: [1, 2] });
  assertEquals(a, b);
  assertNotEquals(a, c);
  // 32-bit FNV-1a → 8 hex chars.
  assertEquals(a.length, 8);
});

Deno.test("computeCostUsd prices input/output/cache tokens from the table", () => {
  // sonnet: input $3/MTok, output $15/MTok.
  const cost = computeCostUsd({
    model: "claude-sonnet-4-6",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  });
  assertEquals(cost, 18);
});

Deno.test("computeCostUsd is 0 (not NaN) for an unknown model", () => {
  const cost = computeCostUsd({
    model: "some-unlisted-model",
    inputTokens: 5_000,
    outputTokens: 5_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  });
  assertEquals(cost, 0);
});
