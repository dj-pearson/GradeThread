import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";
import { notifyUser } from "../lib/notify.ts";
import { sendAdminMessageEmail } from "../lib/email.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";

// US-900: admin triage queue for user-opened support tickets.
//
// Mounted at /api/admin/support-tickets — inherits authMiddleware +
// adminAuthMiddleware (admin/super_admin + AAL2 MFA) from the /api/admin/*
// group in main.ts. All reads + mutations run service-role on the server.
//
// These are admin-gated, intentionally CROSS-TENANT reads/writes (the queue
// spans every user's tickets) — the mandatory per-tenant scoping rule for
// user-initiated endpoints does not apply here; the admin+MFA gate is the
// authorization boundary, mirroring admin-support.ts / admin-disputes.ts. Every
// state change (status/priority/assignee, reply, note) is written for real
// (verified row-changed) and audited.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminSupportTicketsRoutes = new Hono<AdminEnv>();

const db = supabaseAdmin as unknown as CheckedUpdateClient;

const FILTERABLE_STATUSES = new Set([
  "open",
  "pending",
  "resolved",
  "closed",
]);
const VALID_STATUSES = FILTERABLE_STATUSES;
const VALID_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const MAX_REPLY_CHARS = 4000;
const PAGE_SIZE = 50;

function auditLog(
  c: Context,
  action: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  return writeAuditLog(c, {
    action,
    targetType: "support_ticket",
    targetId,
    details,
  });
}

// Resolve { id → { email, full_name } } for a set of user ids in one read so the
// queue can show who each ticket belongs to / is assigned to without N+1 reads.
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

// ── GET / — the queue. ?status= and ?assignee= filters, server-side paging. ──
adminSupportTicketsRoutes.get("/", async (c) => {
  const statusParam = c.req.query("status");
  const status = statusParam && FILTERABLE_STATUSES.has(statusParam)
    ? statusParam
    : null;
  const assignee = c.req.query("assignee"); // an admin id, or "me", or unset
  const page = Math.max(0, Number(c.req.query("page") ?? "0") || 0);

  let query = supabaseAdmin
    .from("support_tickets")
    .select(
      "id, user_id, subject, status, priority, assigned_admin_id, " +
        "last_message_at, resolved_at, created_at",
      { count: "exact" },
    )
    .order("last_message_at", { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (status) query = query.eq("status", status);
  if (assignee) {
    query = query.eq(
      "assigned_admin_id",
      assignee === "me" ? c.get("userId") : assignee,
    );
  }

  const { data, error, count } = await query;
  if (error) {
    console.error("[admin-support-tickets] list failed:", error.message);
    return c.json({ error: "Could not load tickets" }, 500);
  }

  const rows = (data ?? []) as unknown as Array<
    { user_id: string; assigned_admin_id: string | null } & Record<
      string,
      unknown
    >
  >;
  const dir = await loadUserDirectory(
    rows.flatMap((r) =>
      [r.user_id, r.assigned_admin_id].filter(Boolean) as string[]
    ),
  );

  const tickets = rows.map((r) => ({
    ...r,
    user_email: dir.get(r.user_id)?.email ?? null,
    user_name: dir.get(r.user_id)?.full_name ?? null,
    assigned_admin_email: r.assigned_admin_id
      ? dir.get(r.assigned_admin_id)?.email ?? null
      : null,
  }));

  // Open + pending count for the nav badge (independent of the current filter).
  const { count: openCount } = await supabaseAdmin
    .from("support_tickets")
    .select("id", { count: "exact", head: true })
    .in("status", ["open", "pending"]);

  return c.json({
    tickets,
    total: count ?? 0,
    page,
    page_size: PAGE_SIZE,
    open_count: openCount ?? 0,
  });
});

// ── GET /count — just the open/pending badge count (cheap nav poll) ──────────
adminSupportTicketsRoutes.get("/count", async (c) => {
  const { count, error } = await supabaseAdmin
    .from("support_tickets")
    .select("id", { count: "exact", head: true })
    .in("status", ["open", "pending"]);
  if (error) {
    console.error("[admin-support-tickets] count failed:", error.message);
    return c.json({ open_count: 0 });
  }
  return c.json({ open_count: count ?? 0 });
});

// ── GET /:id — full ticket + complete transcript (INCLUDING internal notes) ──
adminSupportTicketsRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");

  const { data: ticket } = await supabaseAdmin
    .from("support_tickets")
    .select(
      "id, user_id, subject, status, priority, assigned_admin_id, " +
        "last_message_at, resolved_at, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (!ticket) return c.json({ error: "Ticket not found" }, 404);
  const t = ticket as unknown as
    & Record<string, unknown>
    & { user_id: string; assigned_admin_id: string | null };

  const { data: messages } = await supabaseAdmin
    .from("support_ticket_messages")
    .select("id, author_user_id, body, is_internal_note, created_at")
    .eq("ticket_id", id)
    .order("created_at", { ascending: true })
    .limit(500);

  const msgRows = (messages ?? []) as Array<
    { author_user_id: string | null } & Record<string, unknown>
  >;
  const dir = await loadUserDirectory(
    [t.user_id, t.assigned_admin_id, ...msgRows.map((m) => m.author_user_id)]
      .filter((x): x is string => Boolean(x)),
  );

  // Label each message: 'user' if the author is the ticket owner, else 'admin'.
  const labeled = msgRows.map((m) => ({
    ...m,
    author: m.author_user_id === t.user_id ? "user" : "admin",
    author_email: m.author_user_id
      ? dir.get(m.author_user_id)?.email ?? null
      : null,
  }));

  return c.json({
    ticket: {
      ...t,
      user_email: dir.get(t.user_id)?.email ?? null,
      user_name: dir.get(t.user_id)?.full_name ?? null,
      assigned_admin_email: t.assigned_admin_id
        ? dir.get(t.assigned_admin_id)?.email ?? null
        : null,
    },
    messages: labeled,
  });
});

// ── PATCH /:id — triage: status / priority / assignee (audited) ──────────────
adminSupportTicketsRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");

  let body: { status?: unknown; priority?: unknown; assignee?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { data: existing } = await supabaseAdmin
    .from("support_tickets")
    .select("id, user_id, subject, status, priority, assigned_admin_id")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return c.json({ error: "Ticket not found" }, 404);
  const before = existing as {
    user_id: string;
    subject: string;
    status: string;
    priority: string;
    assigned_admin_id: string | null;
  };

  const updates: Record<string, unknown> = {};

  if (typeof body.status === "string") {
    if (!VALID_STATUSES.has(body.status)) {
      return c.json({ error: "Invalid status" }, 400);
    }
    updates.status = body.status;
    // Stamp/clear resolved_at as the status crosses the resolved/closed line.
    updates.resolved_at =
      body.status === "resolved" || body.status === "closed"
        ? new Date().toISOString()
        : null;
  }

  if (typeof body.priority === "string") {
    if (!VALID_PRIORITIES.has(body.priority)) {
      return c.json({ error: "Invalid priority" }, 400);
    }
    updates.priority = body.priority;
  }

  if (body.assignee !== undefined) {
    // null / "" clears the assignment; "me" assigns to the acting admin.
    const a = body.assignee;
    updates.assigned_admin_id = a === null || a === ""
      ? null
      : a === "me"
      ? c.get("userId")
      : typeof a === "string"
      ? a
      : null;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No supported fields to update" }, 400);
  }

  try {
    await updateByIdChecked(db, "support_tickets", id, updates);
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Ticket could not be updated (no row changed)" }, 409);
    }
    console.error("[admin-support-tickets] patch failed:", err);
    return c.json({ error: "Failed to update ticket" }, 500);
  }

  await auditLog(c, "support_ticket_update", id, {
    user_id: before.user_id,
    before: {
      status: before.status,
      priority: before.priority,
      assigned_admin_id: before.assigned_admin_id,
    },
    after: updates,
  });

  // US-909: a (re)assignment to a DIFFERENT admin notifies that admin via the
  // notification center. Routed through emitOpsEvent (the single pipeline) — no
  // alert fan-out at info severity, just the per-admin notification. Skip a
  // self-assignment (no point pinging yourself).
  const newAssignee = updates.assigned_admin_id;
  if (
    typeof newAssignee === "string" &&
    newAssignee !== before.assigned_admin_id &&
    newAssignee !== c.get("userId")
  ) {
    void emitOpsEvent("ticket.assigned", "info", {
      title: `Support ticket assigned to you: ${before.subject}`,
      source: "support-tickets",
      actorUserId: c.get("userId"),
      data: { link: `/admin/support-tickets/${id}`, ticket_id: id },
      notifyAdminIds: [newAssignee],
    });
  }

  return c.json({ ok: true });
});

// ── POST /:id/reply — admin reply or internal note ───────────────────────────
// Body: { body: string, internal?: boolean }. A non-internal reply notifies the
// user (in-app + the US-582 email delivery) and flips an open ticket to
// 'pending' (waiting on the user). An internal note is operator-only and never
// touches the user.
adminSupportTicketsRoutes.post("/:id/reply", async (c) => {
  const adminId = c.get("userId");
  const id = c.req.param("id");

  let body: { body?: unknown; internal?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const message = typeof body.body === "string"
    ? body.body.trim().slice(0, MAX_REPLY_CHARS)
    : "";
  if (!message) return c.json({ error: "A reply message is required" }, 400);
  const isInternal = body.internal === true;

  const { data: ticket } = await supabaseAdmin
    .from("support_tickets")
    .select("id, user_id, subject, status")
    .eq("id", id)
    .maybeSingle();
  if (!ticket) return c.json({ error: "Ticket not found" }, 404);
  const t = ticket as {
    user_id: string;
    subject: string;
    status: string;
  };

  const { error: insErr } = await supabaseAdmin
    .from("support_ticket_messages")
    .insert({
      ticket_id: id,
      author_user_id: adminId,
      body: message,
      is_internal_note: isInternal,
    } as never);
  if (insErr) {
    console.error("[admin-support-tickets] reply insert failed:", insErr.message);
    return c.json({ error: "Failed to save reply" }, 500);
  }

  // Assign to the replying admin (if unassigned) and bump activity. A public
  // reply moves the ticket to 'pending' (awaiting the user); an internal note
  // leaves the status untouched.
  const nowIso = new Date().toISOString();
  const updates: Record<string, unknown> = {
    assigned_admin_id: adminId,
    last_message_at: nowIso,
  };
  if (!isInternal && (t.status === "open" || t.status === "pending")) {
    updates.status = "pending";
  }
  try {
    await updateByIdChecked(db, "support_tickets", id, updates);
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Ticket could not be updated (no row changed)" }, 409);
    }
    console.error("[admin-support-tickets] reply status update failed:", err);
    return c.json({ error: "Failed to update ticket" }, 500);
  }

  // Notify the user only for a PUBLIC reply — never for an internal note.
  if (!isInternal) {
    await notifyUser(t.user_id, {
      type: "system",
      title: "Support replied to your ticket",
      message: "A support agent has replied. Open your support inbox to read it.",
      link: "/dashboard/support",
    });
    // US-582 durable email delivery (best-effort; never fail the saved reply).
    try {
      const { data: u } = await supabaseAdmin
        .from("users")
        .select("email, full_name")
        .eq("id", t.user_id)
        .maybeSingle();
      const recipient = u as { email: string | null; full_name: string | null } | null;
      if (recipient?.email) {
        await sendAdminMessageEmail(recipient.email, {
          userName: recipient.full_name?.trim() || "there",
          subject: `Re: ${t.subject}`,
          body: message,
          ctaLabel: "View ticket",
          ctaUrl: "https://gradethread.com/dashboard/support",
        });
      }
    } catch (err) {
      console.error(
        "[admin-support-tickets] reply email failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  await auditLog(c, isInternal ? "support_ticket_note" : "support_ticket_reply", id, {
    user_id: t.user_id,
    internal: isInternal,
    reply_length: message.length,
  });

  return c.json({ ok: true, internal: isInternal });
});
