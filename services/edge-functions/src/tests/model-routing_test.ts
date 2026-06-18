// US-1066: confidence-gated model routing (cheaper-model cascade) tests.

import { assertEquals } from "@std/assert";

// Env BEFORE importing modules that touch the supabase client at import time
// (model-routing → ai-config → system-settings → supabase).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  normalizeCascadeConfig,
  decideEscalation,
  defaultCascadeConfig,
} = await import("../lib/model-routing.ts");

Deno.test("normalizeCascadeConfig: missing/garbage → safe defaults (disabled)", () => {
  const d = defaultCascadeConfig();
  for (const raw of [null, undefined, "x", 42, []]) {
    const c = normalizeCascadeConfig(raw);
    assertEquals(c.enabled, false);
    assertEquals(c.firstPassModel, d.firstPassModel);
    assertEquals(c.escalationModel, d.escalationModel);
    assertEquals(c.confidenceThreshold, d.confidenceThreshold);
    assertEquals(c.highValueUsd, null);
  }
});

Deno.test("normalizeCascadeConfig: valid allowlisted models pass through", () => {
  const c = normalizeCascadeConfig({
    enabled: true,
    firstPassModel: "claude-haiku-4-5-20251001",
    escalationModel: "claude-opus-4-8",
    confidenceThreshold: 0.8,
    highValueUsd: 250,
  });
  assertEquals(c.enabled, true);
  assertEquals(c.firstPassModel, "claude-haiku-4-5-20251001");
  assertEquals(c.escalationModel, "claude-opus-4-8");
  assertEquals(c.confidenceThreshold, 0.8);
  assertEquals(c.highValueUsd, 250);
});

Deno.test("normalizeCascadeConfig: non-allowlisted model falls back to default", () => {
  const d = defaultCascadeConfig();
  const c = normalizeCascadeConfig({
    enabled: true,
    firstPassModel: "gpt-4o-mini",
    escalationModel: "definitely-not-a-model",
  });
  assertEquals(c.firstPassModel, d.firstPassModel);
  assertEquals(c.escalationModel, d.escalationModel);
});

Deno.test("normalizeCascadeConfig: confidenceThreshold clamps out-of-range", () => {
  const d = defaultCascadeConfig();
  assertEquals(normalizeCascadeConfig({ confidenceThreshold: 0 }).confidenceThreshold, d.confidenceThreshold);
  assertEquals(normalizeCascadeConfig({ confidenceThreshold: 1.5 }).confidenceThreshold, d.confidenceThreshold);
  assertEquals(normalizeCascadeConfig({ confidenceThreshold: -1 }).confidenceThreshold, d.confidenceThreshold);
  assertEquals(normalizeCascadeConfig({ confidenceThreshold: 1 }).confidenceThreshold, 1);
  assertEquals(normalizeCascadeConfig({ confidenceThreshold: 0.6 }).confidenceThreshold, 0.6);
});

Deno.test("normalizeCascadeConfig: highValueUsd accepts positive, rejects <=0/garbage, allows null", () => {
  assertEquals(normalizeCascadeConfig({ highValueUsd: 100 }).highValueUsd, 100);
  assertEquals(normalizeCascadeConfig({ highValueUsd: 0 }).highValueUsd, null);
  assertEquals(normalizeCascadeConfig({ highValueUsd: -5 }).highValueUsd, null);
  assertEquals(normalizeCascadeConfig({ highValueUsd: "200" }).highValueUsd, null);
  assertEquals(normalizeCascadeConfig({ highValueUsd: null }).highValueUsd, null);
});

const ENABLED = {
  enabled: true,
  firstPassModel: "claude-haiku-4-5-20251001",
  escalationModel: "claude-sonnet-4-6",
  confidenceThreshold: 0.75,
  highValueUsd: 200 as number | null,
};

Deno.test("decideEscalation: disabled cascade never escalates", () => {
  const r = decideEscalation({
    confidence: 0.1,
    itemValueUsd: 9999,
    config: { ...ENABLED, enabled: false },
  });
  assertEquals(r.escalate, false);
  assertEquals(r.reason, "cascade_disabled");
});

Deno.test("decideEscalation: identical first/escalation model is a no-op", () => {
  const r = decideEscalation({
    confidence: 0.1,
    itemValueUsd: null,
    config: { ...ENABLED, escalationModel: ENABLED.firstPassModel },
  });
  assertEquals(r.escalate, false);
  assertEquals(r.reason, "no_stronger_model");
});

Deno.test("decideEscalation: high value escalates regardless of confidence", () => {
  const r = decideEscalation({
    confidence: 0.99,
    itemValueUsd: 200,
    config: ENABLED,
  });
  assertEquals(r.escalate, true);
  assertEquals(r.reason, "high_value");
});

Deno.test("decideEscalation: low confidence escalates", () => {
  const r = decideEscalation({
    confidence: 0.74,
    itemValueUsd: 10,
    config: ENABLED,
  });
  assertEquals(r.escalate, true);
  assertEquals(r.reason, "low_confidence");
});

Deno.test("decideEscalation: confident + not high value stays on the cheap model", () => {
  const r = decideEscalation({
    confidence: 0.9,
    itemValueUsd: 10,
    config: ENABLED,
  });
  assertEquals(r.escalate, false);
  assertEquals(r.reason, "confident");
});

Deno.test("decideEscalation: threshold is strict (== threshold does not escalate)", () => {
  const r = decideEscalation({
    confidence: 0.75,
    itemValueUsd: null,
    config: { ...ENABLED, highValueUsd: null },
  });
  assertEquals(r.escalate, false);
  assertEquals(r.reason, "confident");
});
