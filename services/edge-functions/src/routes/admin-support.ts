import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { notifyUser } from "../lib/notify.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";
import { requireScope } from "../lib/scope-guard.ts";

// US-839: admin support inbox for escalated AI-assistant conversations.
//
// Mounted at /api/admin/support — inherits authMiddleware + adminAuthMiddleware
// (admin/super_admin + AAL2 MFA) from the /api/admin/* group in main.ts. All
// reads + mutations run service-role on the server (the SPA can't write the
// transcript directly; support_messages has no client INSERT policy, 00181).
//
// WHY EDGE-SIDE: the human-reply write inserts a `human_agent` row and notifies
// the end user. Doing it from the browser would no-op under RLS (no client
// write policy) exactly like the dispute mutations did before US-474, so these
// handlers do the writes for real and verify a row actually changed.
//
// These are admin-gated, intentionally CROSS-TENANT reads/writes (the support
// inbox spans every user's conversations) — the mandatory per-tenant scoping
// rule for user-initiated endpoints does not apply here; the admin+MFA gate is
// the authorization boundary, mirroring admin-disputes.ts.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminSupportRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminSupportRoutes.use("*", requireScope("support:write"));

const db = supabaseAdmin as unknown as CheckedUpdateClient;

// The statuses a human agent can filter the inbox by. "all" means no filter.
const FILTERABLE_STATUSES = new Set([
  "open",
  "awaiting_user",
  "escalated",
  "resolved",
  "closed",
]);

const MAX_REPLY_CHARS = 4000;

function auditLog(
  c: Context,
  action: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  return writeAuditLog(c, {
    action,
    targetType: "support_conversation",
    targetId,
    details,
  });
}

// Resolve { id → { email, full_name } } for a set of user ids in one read, so
// the inbox can show who each conversation belongs to without N+1 queries.
async function loadUserDirectory(
  userIds: string[],
): Promise<Map<string, { email: string | null; full_name: string | null }>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const dir = new Map<
    string,
    { email: string | null; full_name: string | null }
  >();
  if (unique.length === 0) return dir;
  const { data } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name")
    .in("id", unique);
  for (
    const u of (data ?? []) as Array<
      { id: string; email: string | null; full_name: string | null }
    >
  ) {
    dir.set(u.id, { email: u.email, full_name: u.full_name });
  }
  return dir;
}

// In-app + realtime notify the conversation's owner of a human-side action.
// (Inserting a notifications row is the realtime push — that table is in the
// supabase_realtime publication, 00007.) Best-effort: notifyUser never throws.
async function notifyConversationUser(
  userId: string,
  title: string,
  message: string,
): Promise<void> {
  await notifyUser(userId, {
    type: "system",
    title,
    message,
    // No user-facing chat route exists yet; the dashboard hosts the
    // notification bell, so land them there.
    link: "/dashboard",
  });
}

// ── Inbox ordering (US-2667) ─────────────────────────────────────────────────
//
// The list is ordered by last_message_at, which is right for every thread except
// one. A crisis handoff is time-critical and it does NOT keep bumping itself up
// the list - the person on the other end typically sends one message and stops,
// so within an hour of ordinary traffic it is off the first screen.
//
// So an OPEN crisis thread sorts first, and everything else keeps the recency
// order the DB already applied. Resolved and closed crisis threads sort
// normally: pinning a finished one forever would train an operator to scroll
// past the top of their own inbox, which is the failure this exists to prevent.
const INBOX_SETTLED_STATUSES: ReadonlySet<string> = new Set([
  "resolved",
  "closed",
]);

export function isUrgentInboxRow(row: {
  escalation_trigger?: unknown;
  status?: unknown;
}): boolean {
  return row.escalation_trigger === "crisis" &&
    !INBOX_SETTLED_STATUSES.has(String(row.status ?? ""));
}

/**
 * Stable: only lifts urgent rows, preserving the query's recency order otherwise.
 *
 * Constrained to `object` rather than to the two fields it reads. A structural
 * constraint of all-optional properties is a WEAK type, and TypeScript rejects
 * an argument that has no property in common with it - which is every row shape
 * the select() actually produces, since those come back as a Record.
 */
export function sortInboxRows<T extends object>(rows: T[]): T[] {
  const urgent: T[] = [];
  const rest: T[] = [];
  for (const r of rows) (isUrgentInboxRow(r) ? urgent : rest).push(r);
  return [...urgent, ...rest];
}

// ── GET /conversations — inbox list, optional ?status= filter ────────────────
adminSupportRoutes.get("/conversations", async (c) => {
  const statusParam = c.req.query("status");
  const status = statusParam && FILTERABLE_STATUSES.has(statusParam)
    ? statusParam
    : null;

  let query = supabaseAdmin
    .from("support_conversations")
    .select(
      "id, user_id, workspace_owner_id, status, subject, escalation_reason, " +
        "escalation_summary, escalation_trigger, assigned_admin_id, " +
        "last_message_at, escalated_at, resolved_at, created_at",
    )
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) {
    console.error("[admin-support] list failed:", error.message);
    return c.json({ error: "Could not load conversations" }, 500);
  }

  const rows = (data ?? []) as unknown as Array<
    { user_id: string; assigned_admin_id: string | null } & Record<
      string,
      unknown
    >
  >;
  const dir = await loadUserDirectory(
    rows.flatMap((r) => [r.user_id, r.assigned_admin_id].filter(Boolean) as string[]),
  );

  const conversations = sortInboxRows(rows.map((r) => ({
    ...r,
    user_email: dir.get(r.user_id)?.email ?? null,
    user_name: dir.get(r.user_id)?.full_name ?? null,
    assigned_admin_email: r.assigned_admin_id
      ? dir.get(r.assigned_admin_id)?.email ?? null
      : null,
  })));

  return c.json({ conversations });
});

// ── GET /conversations/:id — full transcript (incl. tool usage), no system rows
adminSupportRoutes.get("/conversations/:id", async (c) => {
  const id = c.req.param("id");

  const { data: conv } = await supabaseAdmin
    .from("support_conversations")
    .select(
      "id, user_id, workspace_owner_id, status, subject, escalation_reason, " +
        "escalation_summary, escalation_trigger, assigned_admin_id, " +
        "last_message_at, escalated_at, resolved_at, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const convRow = conv as unknown as
    & Record<string, unknown>
    & { user_id: string; assigned_admin_id: string | null };

  // Full ordered transcript. Include tool_calls + model so the agent can see
  // WHICH tools the assistant used on each turn. Never surface system rows.
  const { data: messages } = await supabaseAdmin
    .from("support_messages")
    .select(
      "id, role, content, tool_calls, model, input_tokens, output_tokens, " +
        "flagged, flag_reason, created_at",
    )
    .eq("conversation_id", id)
    .neq("role", "system")
    .order("created_at", { ascending: true })
    .limit(500);

  const dir = await loadUserDirectory(
    [convRow.user_id, convRow.assigned_admin_id].filter(Boolean) as string[],
  );

  return c.json({
    conversation: {
      ...convRow,
      user_email: dir.get(convRow.user_id)?.email ?? null,
      user_name: dir.get(convRow.user_id)?.full_name ?? null,
      assigned_admin_email: convRow.assigned_admin_id
        ? dir.get(convRow.assigned_admin_id)?.email ?? null
        : null,
    },
    messages: messages ?? [],
  });
});

// ── POST /conversations/:id/reply — human agent answers the thread ───────────
// Persists a human_agent message, assigns the conversation to the replying
// admin, flips status to awaiting_user, and notifies the user (in-app + realtime).
adminSupportRoutes.post("/conversations/:id/reply", async (c) => {
  const adminId = c.get("userId");
  const id = c.req.param("id");

  let body: { message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const message = typeof body.message === "string"
    ? body.message.trim().slice(0, MAX_REPLY_CHARS)
    : "";
  if (!message) return c.json({ error: "A reply message is required" }, 400);

  const { data: conv } = await supabaseAdmin
    .from("support_conversations")
    .select("id, user_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const { user_id: convUserId } = conv as { user_id: string; status: string };

  // Persist the human reply turn.
  const { error: insErr } = await supabaseAdmin.from("support_messages").insert({
    conversation_id: id,
    role: "human_agent",
    content: message,
  } as never);
  if (insErr) {
    console.error("[admin-support] reply insert failed:", insErr.message);
    return c.json({ error: "Failed to save reply" }, 500);
  }

  // Assign to the replying admin, flip to awaiting_user, bump activity. Verify
  // a row changed so a vanished/renamed conversation surfaces a real error.
  const nowIso = new Date().toISOString();
  try {
    await updateByIdChecked(db, "support_conversations", id, {
      status: "awaiting_user",
      assigned_admin_id: adminId,
      last_message_at: nowIso,
    });
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Conversation could not be updated (no row changed)" }, 409);
    }
    console.error("[admin-support] reply status update failed:", err);
    return c.json({ error: "Failed to update conversation" }, 500);
  }

  await notifyConversationUser(
    convUserId,
    "Support replied to your conversation",
    "A support agent has replied. Open your dashboard to read their response.",
  );

  await auditLog(c, "support_conversation_reply", id, {
    user_id: convUserId,
    reply_length: message.length,
  });

  return c.json({ ok: true, status: "awaiting_user" });
});

// ── POST /conversations/:id/resolve — close out the thread ───────────────────
// Body: { close?: boolean }. Stamps resolved_at and notifies the user. `close`
// transitions to 'closed' (archived); otherwise 'resolved'.
adminSupportRoutes.post("/conversations/:id/resolve", async (c) => {
  const id = c.req.param("id");

  let body: { close?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const close = body.close === true;
  const status = close ? "closed" : "resolved";

  const { data: conv } = await supabaseAdmin
    .from("support_conversations")
    .select("id, user_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const { user_id: convUserId } = conv as { user_id: string; status: string };

  const nowIso = new Date().toISOString();
  try {
    await updateByIdChecked(db, "support_conversations", id, {
      status,
      resolved_at: nowIso,
      last_message_at: nowIso,
    });
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Conversation could not be updated (no row changed)" }, 409);
    }
    console.error("[admin-support] resolve update failed:", err);
    return c.json({ error: "Failed to resolve conversation" }, 500);
  }

  await notifyConversationUser(
    convUserId,
    close ? "Support conversation closed" : "Support conversation resolved",
    close
      ? "Your support conversation has been closed. Reply any time to reopen it."
      : "Your support conversation has been marked resolved. Reply any time if you still need help.",
  );

  await auditLog(c, "support_conversation_resolved", id, {
    user_id: convUserId,
    status,
  });

  return c.json({ ok: true, status });
});
