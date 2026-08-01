// Unit tests for the AI-action quality-gated cascade (US-1065 follow-up).
//
//   deno test src/tests/ai-action-cascade_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  type ActionCascadeConfig,
  type CascadeAssessment,
  normalizeActionCascadeConfig,
  runActionCascade,
} from "../lib/ai-action-cascade.ts";

// Explicit config so tests don't depend on the Haiku/Sonnet env fallbacks.
function cfg(overrides: Partial<ActionCascadeConfig> = {}): ActionCascadeConfig {
  return {
    enabled: true,
    firstPassModel: "haiku",
    escalationModel: "sonnet",
    confidenceThreshold: 0.7,
    ...overrides,
  };
}

// A run that records which models it was invoked with, returning the model name.
function recordingRun() {
  const calls: string[] = [];
  return {
    calls,
    runOn: (model: string) => {
      calls.push(model);
      return Promise.resolve(model);
    },
  };
}

const sufficient: (r: string) => CascadeAssessment = () => ({
  sufficient: true,
  reason: "ok",
});
const insufficient: (r: string) => CascadeAssessment = () => ({
  sufficient: false,
  reason: "low_confidence",
});

// ── normalize ────────────────────────────────────────────────────
Deno.test("normalize: null/garbage → disabled default", () => {
  assertEquals(normalizeActionCascadeConfig(null).enabled, false);
  assertEquals(normalizeActionCascadeConfig("nope").enabled, false);
});

Deno.test("normalize: honors enabled + explicit models + clamps threshold", () => {
  const c = normalizeActionCascadeConfig({
    enabled: true,
    firstPassModel: "claude-haiku-4-5",
    escalationModel: "claude-sonnet-5",
    confidenceThreshold: 0.9,
  });
  assertEquals(c.enabled, true);
  assertEquals(c.firstPassModel, "claude-haiku-4-5");
  assertEquals(c.escalationModel, "claude-sonnet-5");
  assertEquals(c.confidenceThreshold, 0.9);

  // out-of-range threshold falls back to the default 0.7
  assertEquals(normalizeActionCascadeConfig({ confidenceThreshold: 5 }).confidenceThreshold, 0.7);
  // non-string model falls back (not empty)
  assert(normalizeActionCascadeConfig({ firstPassModel: 123 }).firstPassModel.length > 0);
});

// ── runner: disabled / no-stronger ───────────────────────────────
Deno.test("disabled → single pass on the escalation (default) model", async () => {
  const { calls, runOn } = recordingRun();
  const out = await runActionCascade({
    config: cfg({ enabled: false }),
    runOn,
    assess: insufficient, // ignored when disabled
  });
  assertEquals(calls, ["sonnet"]);
  assertEquals(out.model, "sonnet");
  assertEquals(out.escalated, false);
  assertEquals(out.outcome, "cascade_disabled");
});

Deno.test("first === escalation model → single pass, no_stronger_model", async () => {
  const { calls, runOn } = recordingRun();
  const out = await runActionCascade({
    config: cfg({ firstPassModel: "sonnet", escalationModel: "sonnet" }),
    runOn,
    assess: insufficient,
  });
  assertEquals(calls, ["sonnet"]);
  assertEquals(out.escalated, false);
  assertEquals(out.outcome, "no_stronger_model");
});

// ── runner: sufficient → keep first pass ─────────────────────────
Deno.test("enabled + sufficient → keep the cheap first pass, no escalation", async () => {
  const { calls, runOn } = recordingRun();
  const out = await runActionCascade({ config: cfg(), runOn, assess: sufficient });
  assertEquals(calls, ["haiku"]); // only the cheap call ran
  assertEquals(out.model, "haiku");
  assertEquals(out.escalated, false);
  assertEquals(out.outcome, "first_pass_sufficient");
  assertEquals(out.reason, null);
});

// ── runner: insufficient → escalate ──────────────────────────────
Deno.test("enabled + insufficient → escalate to the stronger model", async () => {
  const { calls, runOn } = recordingRun();
  const escalations: Array<{ from: string; to: string; reason: string }> = [];
  const out = await runActionCascade({
    config: cfg(),
    runOn,
    assess: insufficient,
    onEscalate: (i) => escalations.push(i),
  });
  assertEquals(calls, ["haiku", "sonnet"]); // both ran, in order
  assertEquals(out.model, "sonnet");
  assertEquals(out.escalated, true);
  assertEquals(out.outcome, "first_pass_insufficient");
  assertEquals(out.reason, "low_confidence");
  assertEquals(escalations.length, 1);
  assertEquals(escalations[0].from, "haiku");
  assertEquals(escalations[0].to, "sonnet");
});

// ── runner: first pass throws → escalate, don't fail ─────────────
Deno.test("enabled + first pass throws → escalate (first_pass_error)", async () => {
  const calls: string[] = [];
  const out = await runActionCascade({
    config: cfg(),
    runOn: (model) => {
      calls.push(model);
      if (model === "haiku") throw new Error("haiku produced no listing");
      return Promise.resolve(model);
    },
    assess: sufficient,
  });
  assertEquals(calls, ["haiku", "sonnet"]);
  assertEquals(out.model, "sonnet");
  assertEquals(out.escalated, true);
  assertEquals(out.outcome, "first_pass_error");
  assert(out.reason?.startsWith("first_pass_error"));
});
