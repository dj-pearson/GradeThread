// US-2035: pin what grading's sampling path ACTUALLY does.
//
// ai-config.ts asserted for a long time that grading "ALWAYS uses a low
// temperature, defaulting to 0 (fully greedy decoding)". It stopped being true
// when the default grading model became effort-based, and nothing caught it —
// the claim lived only in a comment, so there was no way for it to fail.
//
// These tests exist so the DIVERGENCE between the documented intent (US-481
// reproducibility) and the shipping behaviour stays visible and executable. If
// someone later pins a decoding mode that restores determinism, or routes
// grading back to a temperature-accepting model, these fail loudly and the
// US-2035 comment blocks must be revisited in the same commit.

import { assert, assertEquals } from "@std/assert";

// ai-config.ts transitively pulls in the service-role Supabase client, which
// throws at module scope without these. Set them before the dynamic import,
// same as the other ai-* unit tests.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  getDefaultModel,
  gradingSamplingParams,
  modelUsesEffort,
  getGradingTemperature,
  GRADING_DEFAULT_TEMPERATURE,
  GRADING_MAX_TEMPERATURE,
} = await import("../lib/ai-config.ts");

Deno.test("US-2035: the DEFAULT grading model is effort-based", () => {
  // This is the root of the whole defect. If it flips, the temperature path is
  // live again and every US-2035 comment needs rechecking.
  assert(
    modelUsesEffort(getDefaultModel()),
    `getDefaultModel() (${getDefaultModel()}) is no longer effort-based — the US-2035 ` +
      `comment blocks in ai-config.ts and grading-reliability.ts describe the ` +
      `effort-based path and must be revisited.`,
  );
});

Deno.test("US-2035: grading sends NO temperature on the default model", () => {
  const params = gradingSamplingParams(getDefaultModel()) as Record<string, unknown>;

  // The documented promise was greedy decoding. The reality is the model's own
  // non-greedy default. Asserting the absence is the point: it is what makes a
  // regrade of identical photos able to return a different score.
  assertEquals(
    params.temperature,
    undefined,
    "grading is documented as greedy but sends no temperature — if this now " +
      "sends one, determinism may have been restored and US-2035 AC1 is answered",
  );
  assert("output_config" in params, "effort-based models steer via output_config");
});

Deno.test("US-2035: the legacy temperature path is still correct where it applies", () => {
  // Retained deliberately for Sonnet 4.x / Haiku, which DO accept temperature.
  // The clamping apparatus is dead on the default model, not wrong in general.
  const legacy = "claude-3-5-haiku-20241022";
  assert(!modelUsesEffort(legacy));
  const params = gradingSamplingParams(legacy) as Record<string, unknown>;
  assertEquals(params.temperature, GRADING_DEFAULT_TEMPERATURE);
  assertEquals(GRADING_DEFAULT_TEMPERATURE, 0);
});

Deno.test("US-2035: GRADING_AI_TEMPERATURE stays clamped to the reproducible band", () => {
  const prev = Deno.env.get("GRADING_AI_TEMPERATURE");
  try {
    Deno.env.set("GRADING_AI_TEMPERATURE", "5");
    assertEquals(getGradingTemperature(), GRADING_MAX_TEMPERATURE);
    Deno.env.set("GRADING_AI_TEMPERATURE", "not-a-number");
    assertEquals(getGradingTemperature(), GRADING_DEFAULT_TEMPERATURE);
  } finally {
    if (prev === undefined) Deno.env.delete("GRADING_AI_TEMPERATURE");
    else Deno.env.set("GRADING_AI_TEMPERATURE", prev);
  }
});
