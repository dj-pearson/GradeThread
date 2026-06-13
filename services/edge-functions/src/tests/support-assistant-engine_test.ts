// US-834: AI Support Assistant engine tests. Cover the two security-critical,
// model-free guarantees from the acceptance criteria:
//   * the GATE rejects non-subscribers and locked-out callers,
//   * the tool-use loop is BOUNDED (never exceeds the iteration cap), and
//   * the tool registry is a fixed allowlist with NO write tool reachable.
//
// Pure/injectable engine surface → no live DB or real model needed.

import { assert, assertEquals, assertRejects } from "@std/assert";
// Type-only import (erased at runtime, so it doesn't load the module before the
// env vars below are set — the runtime surface comes from the dynamic import).
import type {
  AssistantStep,
  ToolContext,
} from "../lib/support-assistant-engine.ts";

// support-* libs import supabase.ts at module load, which throws if these aren't
// set — mirror support-kb-search_test.ts / tenant-isolation_test.ts.
Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const E = await import("../lib/support-assistant-engine.ts");

// ── Gate ─────────────────────────────────────────────────────────────────────

Deno.test("gate: active and trialing subscribers are allowed", () => {
  assertEquals(
    E.evaluateAssistantGate({
      subscription_status: "active",
      support_assistant_locked_until: null,
    }).allowed,
    true,
  );
  assertEquals(
    E.evaluateAssistantGate({
      subscription_status: "trialing",
      support_assistant_locked_until: null,
    }).allowed,
    true,
  );
});

Deno.test("gate: non-subscribers are rejected with not_subscribed", () => {
  for (const status of ["canceled", "past_due", "none", "incomplete", null]) {
    const r = E.evaluateAssistantGate({
      subscription_status: status,
      support_assistant_locked_until: null,
    });
    assert(!r.allowed, `status ${status} should be blocked`);
    if (!r.allowed) {
      assertEquals(r.status, 403);
      assertEquals(r.code, "not_subscribed");
    }
  }
});

Deno.test("gate: a future lockout blocks even an active subscriber", () => {
  const now = new Date("2026-06-13T00:00:00Z");
  const future = new Date("2026-06-13T01:00:00Z").toISOString();
  const r = E.evaluateAssistantGate(
    { subscription_status: "active", support_assistant_locked_until: future },
    now,
  );
  assert(!r.allowed);
  if (!r.allowed) assertEquals(r.code, "locked");
});

Deno.test("gate: an expired lockout no longer blocks", () => {
  const now = new Date("2026-06-13T00:00:00Z");
  const past = new Date("2026-06-12T23:00:00Z").toISOString();
  const r = E.evaluateAssistantGate(
    { subscription_status: "active", support_assistant_locked_until: past },
    now,
  );
  assertEquals(r.allowed, true);
});

// ── Tool registry: fixed allowlist, no write tool ────────────────────────────

Deno.test("registry: exactly the read-only + KB + escalate tools, no write verbs", () => {
  const names = [...E.ASSISTANT_TOOL_NAMES].sort();
  assertEquals(names, [
    "escalate_to_human",
    "get_grade_report",
    "get_inventory_status",
    "get_listings",
    "get_open_submissions",
    "get_plan_and_limits",
    "get_sales_summary",
    "search_knowledge_base",
  ]);
  // No mutating verb is exposed anywhere in the registry.
  for (const name of names) {
    assert(
      !/(create|update|delete|publish|insert|write|set_|remove)/.test(name),
      `tool ${name} looks like a write tool`,
    );
  }
});

Deno.test("executor: an unregistered tool name is refused (no write reachable)", async () => {
  const ctx: ToolContext = {
    ownerId: "u1",
    userId: "u1",
    conversationId: "c1",
  };
  await assertRejects(
    () => E.executeAssistantTool("delete_inventory", {}, ctx),
    Error,
    "Unknown or disallowed tool",
  );
});

// ── Bounded tool-use loop ────────────────────────────────────────────────────

// A step that ALWAYS asks for a tool — used to prove the loop can't run forever.
function neverEndingStep(): (
  m: unknown,
) => Promise<AssistantStep> {
  let i = 0;
  return () => {
    i++;
    return Promise.resolve({
      text: `step ${i}`,
      toolUses: [{ id: `t${i}`, name: "get_inventory_status", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
      assistantContent: [{ type: "text", text: `step ${i}` }],
    });
  };
}

Deno.test("loop: stops at the iteration cap when the model keeps requesting tools", async () => {
  let toolCalls = 0;
  const result = await E.runAssistantLoop([{ role: "user", content: "hi" }], {
    step: neverEndingStep(),
    executeTool: () => {
      toolCalls++;
      return Promise.resolve({ ok: true });
    },
    maxIterations: 3,
  });
  assertEquals(result.iterations, 3);
  assertEquals(result.hitCap, true);
  // One tool executed per bounded iteration → never unbounded.
  assertEquals(toolCalls, 3);
  // Tokens accumulate across the bounded turns.
  assertEquals(result.inputTokens, 30);
  assertEquals(result.outputTokens, 15);
});

Deno.test("loop: a final (non-tool) answer ends the loop immediately", async () => {
  let steps = 0;
  const result = await E.runAssistantLoop([{ role: "user", content: "hi" }], {
    step: () => {
      steps++;
      return Promise.resolve({
        text: "Here is your answer.",
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 7, outputTokens: 3 },
        assistantContent: [{ type: "text", text: "Here is your answer." }],
      });
    },
    executeTool: () => Promise.resolve(null),
    maxIterations: E.MAX_TOOL_ITERATIONS,
  });
  assertEquals(steps, 1);
  assertEquals(result.hitCap, false);
  assertEquals(result.finalText, "Here is your answer.");
  assertEquals(result.toolCalls.length, 0);
});

Deno.test("loop: executes a requested tool then finishes on the next turn", async () => {
  const seen: string[] = [];
  let call = 0;
  const result = await E.runAssistantLoop([{ role: "user", content: "count?" }], {
    step: () => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          text: "",
          toolUses: [{ id: "t1", name: "get_inventory_status", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 5, outputTokens: 2 },
          assistantContent: [
            { type: "tool_use", id: "t1", name: "get_inventory_status", input: {} },
          ],
        });
      }
      return Promise.resolve({
        text: "You have 3 items.",
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 6, outputTokens: 4 },
        assistantContent: [{ type: "text", text: "You have 3 items." }],
      });
    },
    executeTool: (name) => {
      seen.push(name);
      return Promise.resolve({ total: 3 });
    },
    maxIterations: E.MAX_TOOL_ITERATIONS,
  });
  assertEquals(result.hitCap, false);
  assertEquals(seen, ["get_inventory_status"]);
  assertEquals(result.finalText, "You have 3 items.");
  assertEquals(result.toolCalls.length, 1);
});
