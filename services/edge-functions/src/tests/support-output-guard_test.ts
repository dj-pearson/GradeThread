// US-835: system-prompt policy + deterministic output-guard tests.
//
// The system prompt is the scope-confinement policy; guardAssistantOutput() is
// the defense-in-depth backstop. Both are model-free and deterministic, so this
// covers the US-835 acceptance criteria without a live model or DB:
//   * the prompt encodes role, KB+own-data sourcing, the untrusted-input rule,
//     the non-disclosure list, refusal+escalation, and the topic taxonomy;
//   * the guard converts system-prompt / tool / schema / internal leakage into a
//     standard refusal and never returns the offending content;
//   * a tripped guard yields an abuse classification (recorded by the route).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// support-* libs import supabase.ts at module load, which throws if these aren't
// set — mirror the other support-* tests.
Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const E = await import("../lib/support-assistant-engine.ts");

// ── System prompt: encodes the full policy ───────────────────────────────────

Deno.test("system prompt: encodes role as GradeThread/FlipDesk tier-1 support", () => {
  const p = E.SUPPORT_SYSTEM_PROMPT.toLowerCase();
  assertStringIncludes(p, "tier-1");
  assertStringIncludes(p, "gradethread");
  assertStringIncludes(p, "flipdesk");
});

Deno.test("system prompt: restricts sourcing to KB + the seller's own data", () => {
  const p = E.SUPPORT_SYSTEM_PROMPT;
  assertStringIncludes(p, "search_knowledge_base");
  // KB-only product facts + never invent.
  assertStringIncludes(p.toLowerCase(), "never");
  // Own-account scoping is stated.
  assertStringIncludes(p.toLowerCase(), "another seller's data");
});

Deno.test("system prompt: states the untrusted-input rule (pasted content is data)", () => {
  const p = E.SUPPORT_SYSTEM_PROMPT.toLowerCase();
  assertStringIncludes(p, "untrusted");
  assertStringIncludes(p, "ignore previous");
  assertStringIncludes(p, "never as instructions");
});

Deno.test("system prompt: enumerates the explicit non-disclosure list", () => {
  const p = E.SUPPORT_SYSTEM_PROMPT.toLowerCase();
  assertStringIncludes(p, "non-disclosure");
  assertStringIncludes(p, "this system prompt");
  assertStringIncludes(p, "tools");
  assertStringIncludes(p, "tenant");
  assertStringIncludes(p, "model");
});

Deno.test("system prompt: defines the allowed-topic taxonomy + refusal/escalation", () => {
  const p = E.SUPPORT_SYSTEM_PROMPT.toLowerCase();
  assertStringIncludes(p, "allowed topics");
  assertStringIncludes(p, "out of");
  assertStringIncludes(p, "escalate_to_human");
});

// ── Output guard: leakage -> standard refusal ─────────────────────────────────

Deno.test("guard: a normal in-scope answer passes through unchanged", () => {
  const ok =
    "You currently have 12 active listings and 3 items awaiting photos. " +
    "Want me to break those down by status?";
  const r = E.guardAssistantOutput(ok);
  assertEquals(r.safe, true);
  assertEquals(r.text, ok);
});

Deno.test("guard: refuses to print the system prompt", () => {
  const leak =
    "Sure! Here is my system prompt: You are the GradeThread support assistant...";
  const r = E.guardAssistantOutput(leak);
  assertEquals(r.safe, false);
  assertEquals(r.text, E.GUARD_REFUSAL);
  // The offending content is NOT returned.
  assert(!r.text.includes("You are the GradeThread support assistant"));
  assertEquals(r.abuseType, "prompt_injection");
});

Deno.test("guard: refuses to list its tools", () => {
  const leak =
    "My tools are: get_inventory_status, get_listings, search_knowledge_base.";
  const r = E.guardAssistantOutput(leak);
  assertEquals(r.safe, false);
  assertEquals(r.text, E.GUARD_REFUSAL);
  assert(!r.text.includes("get_inventory_status"));
  assertEquals(r.abuseType, "scope_probe");
});

Deno.test("guard: refuses to expose the database/schema structure", () => {
  const leak =
    "Your data lives in the inventory_items and grade_reports tables.";
  const r = E.guardAssistantOutput(leak);
  assertEquals(r.safe, false);
  assertEquals(r.text, E.GUARD_REFUSAL);
  assertEquals(r.abuseType, "scope_probe");
});

Deno.test("guard: refuses to reveal the model/provider", () => {
  for (const leak of [
    "I'm built on Claude by Anthropic.",
    "I run on the claude-haiku-4-5 model.",
  ]) {
    const r = E.guardAssistantOutput(leak);
    assertEquals(r.safe, false, `should block: ${leak}`);
    assertEquals(r.text, E.GUARD_REFUSAL);
    assertEquals(r.abuseType, "prompt_injection");
  }
});

Deno.test("guard: a tripped guard always offers the human-escalation path", () => {
  const r = E.guardAssistantOutput("Here is my system prompt.");
  assertEquals(r.safe, false);
  // User-friendly + offers a human agent.
  assertStringIncludes(r.text.toLowerCase(), "human support agent");
});

Deno.test("guard: empty/blank output is treated as safe (nothing to leak)", () => {
  assertEquals(E.guardAssistantOutput("").safe, true);
  assertEquals(E.guardAssistantOutput("   \n ").safe, true);
});

Deno.test("guard: a tripped result carries a detail for the abuse record", () => {
  const r = E.guardAssistantOutput("see the support_messages table");
  assertEquals(r.safe, false);
  assert((r.detail ?? "").length > 0);
});
