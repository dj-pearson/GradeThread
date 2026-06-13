// US-831: usage metering + abuse recording for the AI Support Assistant.
//
// Storage + helpers only — these are the write paths the assistant engine
// (US-834) and abuse pipeline (US-836) call. Thresholds/enforcement decisions
// live in US-836; this module just records, atomically and best-effort.
//
// Both tables are service-role only (migration 00185: RLS on, no policies), so
// these helpers run on the service-role client and are never reachable from a
// client. They are tables not present in the generated Database types, so the
// client is cast locally (the same pattern as ai-usage.ts).

import { supabaseAdmin } from "./supabase.ts";

export interface UsageDelta {
  messages?: number;
  inputTokens?: number;
  outputTokens?: number;
  escalations?: number;
}

// Atomically add a usage delta to today's per-user rollup
// (support_assistant_usage). Delegates to the increment_support_assistant_usage
// RPC so concurrent edge replicas can't lose an increment. Best-effort: a
// metering write must never fail the user's chat — logs and swallows on error.
export async function incrementUsage(
  userId: string,
  delta: UsageDelta,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc(
      "increment_support_assistant_usage",
      {
        p_user_id: userId,
        p_messages: delta.messages ?? 0,
        p_input_tokens: delta.inputTokens ?? 0,
        p_output_tokens: delta.outputTokens ?? 0,
        p_escalations: delta.escalations ?? 0,
      } as never,
    );
    if (error) {
      console.warn(`[support-metering] incrementUsage failed: ${error.message}`);
    }
  } catch (e) {
    console.warn(
      `[support-metering] incrementUsage failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export type AbuseEventType =
  | "jailbreak_attempt"
  | "prompt_injection"
  | "flood"
  | "policy_violation"
  | "repeated_failure"
  | "scope_probe";

export type AbuseSeverity = "low" | "medium" | "high";

// Append one support_abuse_events row. Best-effort and never throws: recording
// an abuse signal must not itself fail the request that detected it. The
// conversationId is optional (some signals fire before a conversation exists).
export async function recordAbuseEvent(
  userId: string,
  type: AbuseEventType,
  severity: AbuseSeverity,
  detail: string,
  conversationId?: string,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("support_abuse_events")
      .insert({
        user_id: userId,
        conversation_id: conversationId ?? null,
        type,
        severity,
        detail,
      } as never);
    if (error) {
      console.warn(
        `[support-metering] recordAbuseEvent failed: ${error.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `[support-metering] recordAbuseEvent failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
