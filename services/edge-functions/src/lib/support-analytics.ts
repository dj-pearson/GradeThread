// US-842: analytics, cost & observability for the AI Support Assistant.
//
// Two concerns live here, both dependency-light and side-effect-safe:
//
//   1. PostHog lifecycle events — fire-and-forget wrappers over captureServer
//      (posthog.ts) for the six moments the owner needs visibility into:
//      message_sent, answer_deflected, escalated, refused, rate_limited,
//      abuse_flagged. Distinct id is the (UUID) user id; properties are
//      NON-PII by contract — token counts, plan tier, model, escalation
//      trigger/reason, abuse type/severity. NEVER pass message content, email,
//      or any free text the user typed.
//
//   2. Pure aggregation functions — deflection rate, escalation-reason
//      breakdown, top topics (proxied by tool usage), and per-conversation
//      cost. These take already-fetched rows and return plain objects so they
//      unit-test with no DB/model (admin-monitoring.ts does the reads).

import { captureServer } from "./posthog.ts";

// ── (1) PostHog lifecycle events ─────────────────────────────────────────────

// Dotted, namespaced event names (mirrors the billing events: trial.expiring_3d,
// subscription.ended). One per lifecycle moment the assistant can reach.
export type AssistantEvent =
  | "assistant.message_sent"
  | "assistant.answer_deflected"
  | "assistant.escalated"
  | "assistant.refused"
  | "assistant.rate_limited"
  | "assistant.abuse_flagged";

// Fire-and-forget capture. The userId is the PostHog distinct id (a UUID, the
// same identifier the SPA identifies by). The caller MUST keep `properties`
// free of PII — this helper does not inspect them. Never throws.
export function captureAssistantEvent(
  userId: string,
  event: AssistantEvent,
  properties: Record<string, unknown> = {},
): void {
  void captureServer(userId, event, { feature: "support_assistant", ...properties });
}

// ── (2) Pure aggregation — deflection ────────────────────────────────────────

export interface ConversationRow {
  id: string;
  status: string | null;
  escalated_at: string | null;
  escalation_trigger: string | null;
  escalation_reason: string | null;
}

export interface DeflectionSummary {
  total: number;
  escalated: number;
  deflected: number;
  /** Share of conversations the bot handled without a human handoff, 0..1. */
  deflectionRate: number;
}

// A conversation counts as escalated once it has been handed off (escalated_at
// set, or its status is the human-held "escalated"). Everything else — open,
// resolved, closed without a handoff — counts as deflected (bot-handled).
function isEscalated(c: ConversationRow): boolean {
  return c.escalated_at != null || c.status === "escalated";
}

export function computeDeflection(convs: ConversationRow[]): DeflectionSummary {
  const total = convs.length;
  const escalated = convs.filter(isEscalated).length;
  const deflected = total - escalated;
  return {
    total,
    escalated,
    deflected,
    deflectionRate: total === 0 ? 0 : Math.round((deflected / total) * 1000) / 1000,
  };
}

// ── (2) Pure aggregation — escalation breakdown ──────────────────────────────

export interface EscalationBreakdown {
  /** Count of escalations by trigger: model | auto | user (DB-free). */
  byTrigger: Record<string, number>;
  /** Most common escalation reasons (capped), highest first. */
  topReasons: Array<{ reason: string; count: number }>;
}

export function computeEscalationBreakdown(
  convs: ConversationRow[],
  reasonLimit = 8,
): EscalationBreakdown {
  const byTrigger: Record<string, number> = {};
  const reasonCounts = new Map<string, number>();
  for (const c of convs) {
    if (!isEscalated(c)) continue;
    const trigger = c.escalation_trigger ?? "unknown";
    byTrigger[trigger] = (byTrigger[trigger] ?? 0) + 1;
    const reason = (c.escalation_reason ?? "").trim();
    if (reason) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const topReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, reasonLimit);
  return { byTrigger, topReasons };
}

// ── (2) Pure aggregation — top topics (proxied by tool usage) ────────────────

// The assistant's tool calls are the best non-PII signal for "what users ask
// about": searching the KB, checking inventory, sales, grades, etc. We surface
// the frequency of each as the top-topics breakdown.
const TOOL_TOPIC_LABELS: Record<string, string> = {
  get_inventory_status: "Inventory status",
  get_listings: "Listings",
  get_sales_summary: "Sales",
  get_grade_report: "Grade reports",
  get_open_submissions: "Submissions",
  get_plan_and_limits: "Plan & limits",
  search_knowledge_base: "Knowledge base",
  escalate_to_human: "Escalation",
};

export interface ToolCallRow {
  // support_messages.tool_calls — JSONB array of { id, name, input } (or null).
  tool_calls: unknown;
}

export function computeTopTopics(
  rows: ToolCallRow[],
  limit = 10,
): Array<{ topic: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!Array.isArray(r.tool_calls)) continue;
    for (const call of r.tool_calls) {
      const name = call && typeof call === "object"
        ? (call as { name?: unknown }).name
        : undefined;
      if (typeof name !== "string" || !name) continue;
      const topic = TOOL_TOPIC_LABELS[name] ?? name.replace(/_/g, " ");
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ── (2) Pure aggregation — cost from persisted token counts ──────────────────

export interface AssistantMessageRow {
  conversation_id: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface CostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  /** Number of conversations that produced at least one billed assistant turn. */
  conversationCount: number;
  /** Highest-cost conversations first (capped). */
  topConversations: Array<{
    conversation_id: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
}

// `estimate(model, tokensIn, tokensOut)` is injected (ai-extract.estimateCost in
// production) so this function stays pure and unit-testable. Cost is computed
// per message from its own stored model + token counts, then rolled up per
// conversation and overall.
export function computeCost(
  msgs: AssistantMessageRow[],
  estimate: (model: string, tokensIn: number, tokensOut: number) => number,
  topLimit = 20,
): CostSummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  const perConv = new Map<
    string,
    { input_tokens: number; output_tokens: number; cost_usd: number }
  >();

  for (const m of msgs) {
    const inTok = m.input_tokens ?? 0;
    const outTok = m.output_tokens ?? 0;
    const cost = estimate(m.model ?? "", inTok, outTok);
    totalInputTokens += inTok;
    totalOutputTokens += outTok;
    totalCostUsd += cost;
    const agg = perConv.get(m.conversation_id) ??
      { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    agg.input_tokens += inTok;
    agg.output_tokens += outTok;
    agg.cost_usd += cost;
    perConv.set(m.conversation_id, agg);
  }

  const topConversations = [...perConv.entries()]
    .map(([conversation_id, v]) => ({
      conversation_id,
      input_tokens: v.input_tokens,
      output_tokens: v.output_tokens,
      cost_usd: Math.round(v.cost_usd * 100000) / 100000,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, topLimit);

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: Math.round(totalCostUsd * 100000) / 100000,
    conversationCount: perConv.size,
    topConversations,
  };
}
