import type { Context } from "hono";
import { supabaseAdmin } from "./supabase.ts";

// Reusable admin audit-log writer (US-269).
//
// Every state-changing admin/super-admin edge handler calls writeAuditLog() so
// admin_audit_log carries a uniform forensic trail: who (actor + role), what
// (action), against what (target_type/target_id), the before/after detail, and
// the request origin (ip + user_agent). Mutations that happen as direct client
// Supabase calls are covered by DB triggers (00046 / 00065) instead — this
// helper is for the service-role edge handlers, which the triggers deliberately
// skip (their auth.uid() is NULL).

// Client IP, trusting Cloudflare's CF-Connecting-IP first (can't be spoofed by
// the client), then the first X-Forwarded-For hop. Mirrors rate-limit.ts.
function clientIp(c: Context): string | null {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

// Cache the acting user's role per request would be ideal, but handlers call
// this at most a couple times; a single SELECT is cheap and keeps the helper
// self-contained.
async function actorRole(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  return (data as { role?: string } | null)?.role ?? null;
}

export interface AuditLogInput {
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Prior state — stored under details.before. */
  before?: unknown;
  /** New state — stored under details.after. */
  after?: unknown;
  /** Any extra structured context merged into details. */
  details?: Record<string, unknown>;
}

/**
 * Write an attributable admin audit-log row for the authenticated caller.
 * Best-effort: a logging failure is reported but never thrown, so it can't
 * roll back the privileged action it is recording.
 */
export async function writeAuditLog(
  c: Context,
  input: AuditLogInput,
): Promise<void> {
  const actorUserId = c.get("userId") as string | undefined;
  if (!actorUserId) {
    console.error("[audit] writeAuditLog called without an authenticated user");
    return;
  }

  const details: Record<string, unknown> = { ...(input.details ?? {}) };
  if (input.before !== undefined) details.before = input.before;
  if (input.after !== undefined) details.after = input.after;

  const { error } = await supabaseAdmin.from("admin_audit_log").insert({
    admin_user_id: actorUserId,
    actor_role: await actorRole(actorUserId),
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    details,
    ip: clientIp(c),
    user_agent: c.req.header("user-agent") ?? null,
  });
  if (error) {
    console.error(`[audit] insert failed for ${input.action}:`, error.message);
  }
}

/**
 * Write a SYSTEM-originated audit row (no human actor) — e.g. the content
 * scheduler tick auto-publishing a post. admin_user_id is NULL and
 * actor_role='system' (allowed by migration 00065).
 */
export async function writeSystemAuditLog(
  input: AuditLogInput,
): Promise<void> {
  const details: Record<string, unknown> = { ...(input.details ?? {}) };
  if (input.before !== undefined) details.before = input.before;
  if (input.after !== undefined) details.after = input.after;

  const { error } = await supabaseAdmin.from("admin_audit_log").insert({
    admin_user_id: null,
    actor_role: "system",
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    details,
  });
  if (error) {
    console.error(`[audit] system insert failed for ${input.action}:`, error.message);
  }
}
