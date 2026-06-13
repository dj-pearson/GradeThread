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

// ── Read helpers for the abuse pipeline (US-836) ─────────────────────────────

export interface TodaySupportUsage {
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Today's per-user usage rollup (support_assistant_usage). Returns zeros when no
// row exists yet (first message of the day). Best-effort: returns zeros on error
// so a transient read can't wrongly lock a user out.
export async function getTodaySupportUsage(
  userId: string,
): Promise<TodaySupportUsage> {
  try {
    const { data, error } = await supabaseAdmin
      .from("support_assistant_usage")
      .select("message_count, input_tokens, output_tokens")
      .eq("user_id", userId)
      .eq("usage_date", new Date().toISOString().slice(0, 10))
      .maybeSingle();
    if (error || !data) return { messageCount: 0, inputTokens: 0, outputTokens: 0 };
    const r = data as {
      message_count?: unknown;
      input_tokens?: unknown;
      output_tokens?: unknown;
    };
    return {
      messageCount: num(r.message_count),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
    };
  } catch (e) {
    console.warn(
      `[support-metering] getTodaySupportUsage failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { messageCount: 0, inputTokens: 0, outputTokens: 0 };
  }
}

// Count this user's HIGH-severity abuse events since `sinceIso` (the rolling
// accumulation window). Best-effort: returns 0 on error.
export async function countHighSeverityAbuseEvents(
  userId: string,
  sinceIso: string,
): Promise<number> {
  try {
    const { count, error } = await supabaseAdmin
      .from("support_abuse_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("severity", "high")
      .gte("created_at", sinceIso);
    if (error) return 0;
    return count ?? 0;
  } catch (e) {
    console.warn(
      `[support-metering] countHighSeverityAbuseEvents failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return 0;
  }
}

// The user's durable prior-lockout count (users.support_assistant_lockout_count),
// which drives the graduated cooldown. Best-effort: returns 0 on error.
export async function getSupportLockoutCount(userId: string): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("support_assistant_lockout_count")
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) return 0;
    return num((data as { support_assistant_lockout_count?: unknown })
      .support_assistant_lockout_count);
  } catch (e) {
    console.warn(
      `[support-metering] getSupportLockoutCount failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return 0;
  }
}

// Atomically apply a lockout (set locked_until + bump the durable count) via the
// apply_support_assistant_lockout RPC (migration 00187). Returns the
// post-increment lockout count, or null on failure.
export async function applySupportLockout(
  userId: string,
  lockedUntilIso: string,
): Promise<number | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc(
      "apply_support_assistant_lockout",
      { p_user_id: userId, p_locked_until: lockedUntilIso } as never,
    );
    if (error) {
      console.warn(
        `[support-metering] applySupportLockout failed: ${error.message}`,
      );
      return null;
    }
    return typeof data === "number" ? data : null;
  } catch (e) {
    console.warn(
      `[support-metering] applySupportLockout failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

// Increment + read this user's per-minute support-message counter via the shared
// rate_limit_counters store (RPC increment_rate_limit, migration 00045), keyed to
// the current UTC minute. Returns the post-increment count. On error returns 1
// (fail-open for one message rather than wrongly blocking).
export async function bumpSupportMinuteCounter(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  try {
    const minuteStart = new Date(now);
    minuteStart.setUTCSeconds(0, 0);
    const { data, error } = await supabaseAdmin.rpc("increment_rate_limit", {
      p_bucket_key: `support_msg:${userId}`,
      p_window_start: minuteStart.toISOString(),
    } as never);
    if (error || typeof data !== "number") return 1;
    return data as number;
  } catch (e) {
    console.warn(
      `[support-metering] bumpSupportMinuteCounter failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return 1;
  }
}

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
