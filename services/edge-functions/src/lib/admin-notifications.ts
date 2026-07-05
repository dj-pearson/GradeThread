// US-909: admin notification center fan-out.
//
// This is the ONE place an ops event becomes per-admin notifications. It is
// called from emitOpsEvent() (lib/ops-events.ts) AFTER the ops_events row is
// persisted, so the notification center REUSES the single ops-event pipeline
// rather than running a parallel notifier (AC5). It never throws — a fan-out
// failure must never disrupt the action that emitted the event.
//
// Recipient policy (pure, unit-tested in resolveNotifyMode):
//   • explicit targets (e.g. a ticket assigned to a specific admin) → just them
//   • else a critical event OR a job failure → broadcast to every admin
//   • else (routine info/warning) → no notification (those live in the feed)

import { supabaseAdmin } from "./supabase.ts";
import { captureException } from "./observability.ts";

export type AdminNotifySeverity = "info" | "warning" | "critical";
export type NotifyMode = "explicit" | "broadcast" | "none";

// Pure routing decision: who (if anyone) gets a notification for this event.
export function resolveNotifyMode(
  type: string,
  severity: AdminNotifySeverity,
  explicitTargetCount: number,
): NotifyMode {
  if (explicitTargetCount > 0) return "explicit";
  if (severity === "critical" || type === "job.failed") return "broadcast";
  return "none";
}

export interface RouteOpsNotificationInput {
  type: string;
  severity: AdminNotifySeverity;
  title: string;
  link: string | null;
  opsEventId: string | null;
  /** Explicit per-admin recipients (e.g. the assignee of a ticket). */
  notifyAdminIds?: string[];
}

// Resolve the broadcast recipient set: every admin / super_admin account.
async function loadAllAdminIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id")
    .in("role", ["admin", "super_admin"]);
  if (error) return [];
  return [...new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))];
}

/**
 * Fan an ops event out to the admin notification center. Best-effort and
 * self-contained: NEVER throws. Inserts one admin_notifications row per
 * resolved recipient (deny-all RLS table; service-role write).
 */
export async function routeOpsEventToAdmins(
  input: RouteOpsNotificationInput,
): Promise<void> {
  try {
    const targets = (input.notifyAdminIds ?? []).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    const mode = resolveNotifyMode(input.type, input.severity, targets.length);
    if (mode === "none") return;

    const recipients = mode === "explicit"
      ? [...new Set(targets)]
      : await loadAllAdminIds();
    if (recipients.length === 0) return;

    const rows = recipients.map((adminId) => ({
      admin_user_id: adminId,
      type: input.type,
      body: input.title,
      link: input.link,
      ops_event_id: input.opsEventId,
      is_read: false,
    }));
    await supabaseAdmin.from("admin_notifications").insert(rows as never);
  } catch (err) {
    captureException(err, {
      route: "admin-notifications.route",
      level: "warn",
      tags: { type: input.type },
    });
  }
}

// US-1657: notify all admins that an agent filed N proposals awaiting sign-off.
// ONE notification per run (batched). Explicit recipient list forces delivery
// (an "info"-severity, non-job.failed event would otherwise be suppressed).
// Best-effort — never throws.
export async function notifyAdminsProposalsFiled(
  agentKey: string,
  _runId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  try {
    const admins = await loadAllAdminIds();
    if (!admins.length) return;
    await routeOpsEventToAdmins({
      type: "agent.proposals_filed",
      severity: "info",
      title: `${agentKey}: ${count} new proposal${count === 1 ? "" : "s"} awaiting review`,
      link: "/admin/agents",
      opsEventId: null,
      notifyAdminIds: admins,
    });
  } catch {
    // best-effort
  }
}
