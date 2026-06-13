// US-842: pure-aggregation tests for the assistant analytics/cost metrics.
// Deflection, escalation breakdown, top topics (tool usage) and cost are all
// computed from already-fetched rows, so they test with no DB/model/PostHog.

import { assertEquals } from "@std/assert";
import {
  computeCost,
  computeDeflection,
  computeEscalationBreakdown,
  computeTopTopics,
  type ConversationRow,
} from "../lib/support-analytics.ts";

function conv(p: Partial<ConversationRow> & { id: string }): ConversationRow {
  return {
    status: null,
    escalated_at: null,
    escalation_trigger: null,
    escalation_reason: null,
    ...p,
  };
}

Deno.test("deflection: bot-resolved vs escalated → rate", () => {
  const convs = [
    conv({ id: "a", status: "resolved" }),
    conv({ id: "b", status: "closed" }),
    conv({ id: "c", status: "open" }),
    conv({ id: "d", status: "escalated", escalated_at: "2026-06-01T00:00:00Z" }),
  ];
  const d = computeDeflection(convs);
  assertEquals(d.total, 4);
  assertEquals(d.escalated, 1);
  assertEquals(d.deflected, 3);
  assertEquals(d.deflectionRate, 0.75);
});

Deno.test("deflection: empty set → zero rate (no divide-by-zero)", () => {
  const d = computeDeflection([]);
  assertEquals(d, { total: 0, escalated: 0, deflected: 0, deflectionRate: 0 });
});

Deno.test("deflection: escalated_at set even if status not 'escalated' still counts", () => {
  const convs = [
    conv({ id: "a", status: "resolved", escalated_at: "2026-06-01T00:00:00Z" }),
  ];
  assertEquals(computeDeflection(convs).escalated, 1);
});

Deno.test("escalation breakdown: by trigger + top reasons (escalated only)", () => {
  const convs = [
    conv({ id: "1", escalated_at: "x", escalation_trigger: "auto", escalation_reason: "Unresolved" }),
    conv({ id: "2", escalated_at: "x", escalation_trigger: "auto", escalation_reason: "Unresolved" }),
    conv({ id: "3", escalated_at: "x", escalation_trigger: "model", escalation_reason: "Billing" }),
    // not escalated — must be ignored even though it has a (stale) reason
    conv({ id: "4", status: "open", escalation_reason: "Should not count" }),
  ];
  const b = computeEscalationBreakdown(convs);
  assertEquals(b.byTrigger, { auto: 2, model: 1 });
  assertEquals(b.topReasons[0], { reason: "Unresolved", count: 2 });
  assertEquals(b.topReasons[1], { reason: "Billing", count: 1 });
  assertEquals(b.topReasons.length, 2);
});

Deno.test("top topics: tool calls aggregated with friendly labels", () => {
  const rows = [
    { tool_calls: [{ name: "search_knowledge_base" }, { name: "get_listings" }] },
    { tool_calls: [{ name: "search_knowledge_base" }] },
    { tool_calls: null }, // no tools — ignored
    { tool_calls: [{ name: "some_future_tool" }] }, // unknown → humanized
  ];
  const topics = computeTopTopics(rows);
  assertEquals(topics[0], { topic: "Knowledge base", count: 2 });
  // Listings + the humanized unknown each appear once.
  const labels = topics.map((t) => t.topic);
  assertEquals(labels.includes("Listings"), true);
  assertEquals(labels.includes("some future tool"), true);
});

Deno.test("cost: per-message estimate rolled up per conversation + overall", () => {
  // Injected estimate: $1/M in, $5/M out (haiku-equivalent), like ai-extract.
  const estimate = (_m: string, tIn: number, tOut: number) =>
    (tIn / 1_000_000) * 1 + (tOut / 1_000_000) * 5;
  const msgs = [
    { conversation_id: "a", model: "claude-haiku", input_tokens: 1_000_000, output_tokens: 1_000_000 },
    { conversation_id: "a", model: "claude-haiku", input_tokens: 0, output_tokens: 1_000_000 },
    { conversation_id: "b", model: "claude-haiku", input_tokens: 2_000_000, output_tokens: 0 },
  ];
  const c = computeCost(msgs, estimate);
  assertEquals(c.totalInputTokens, 3_000_000);
  assertEquals(c.totalOutputTokens, 2_000_000);
  // a: (1+5) + (5) = 11 ; b: 2 ; total = 13
  assertEquals(c.totalCostUsd, 13);
  assertEquals(c.conversationCount, 2);
  // Highest cost first: a ($11) before b ($2).
  assertEquals(c.topConversations[0].conversation_id, "a");
  assertEquals(c.topConversations[0].cost_usd, 11);
  assertEquals(c.topConversations[1].conversation_id, "b");
});

Deno.test("cost: null token counts treated as zero", () => {
  const estimate = () => 0;
  const c = computeCost(
    [{ conversation_id: "a", model: null, input_tokens: null, output_tokens: null }],
    estimate,
  );
  assertEquals(c.totalInputTokens, 0);
  assertEquals(c.totalOutputTokens, 0);
  assertEquals(c.totalCostUsd, 0);
});
