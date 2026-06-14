import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

// US-900: user-facing support ticket inbox. Mounted behind authMiddleware at
// /api/support-tickets, so c.var.userId is the verified caller. A user opens a
// request, reads the thread, and replies; an admin triages from the admin queue
// (admin-support-tickets.ts).
//
// TENANT SCOPING (CLAUDE.md US-268): the service-role client bypasses RLS, so
// EVERY query here is scoped to c.var.userId — directly on support_tickets, and
// on support_ticket_messages via a ticket whose ownership was just verified.
// Internal notes (is_internal_note) are NEVER surfaced to the user: both the RLS
// policy AND this handler exclude them.

type UserEnv = { Variables: { userId: string } };

export const supportTicketRoutes = new Hono<UserEnv>();

const MAX_SUBJECT_CHARS = 200;
const MAX_BODY_CHARS = 4000;

// A message row as stored. Exported so the unit test can exercise the
// user-visibility projection without a live DB.
export interface TicketMessageRow {
  id: string;
  author_user_id: string | null;
  body: string;
  is_internal_note: boolean;
  created_at: string;
}

export interface UserMessageView {
  id: string;
  author: "you" | "support";
  body: string;
  created_at: string;
}

// Project stored messages into what the TICKET OWNER may see: internal notes
// are dropped entirely, and authorship is reduced to you/support (never an
// admin's identity). `ownerId` is the ticket's user_id. Pure → unit-testable.
export function toUserMessageView(
  rows: TicketMessageRow[],
  ownerId: string,
): UserMessageView[] {
  return rows
    .filter((m) => !m.is_internal_note)
    .map((m) => ({
      id: m.id,
      author: m.author_user_id === ownerId ? "you" : "support",
      body: m.body,
      created_at: m.created_at,
    }));
}

// ── GET / — the caller's tickets, newest activity first ──────────────────────
supportTicketRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("support_tickets")
    .select("id, subject, status, priority, last_message_at, resolved_at, created_at")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("[support-tickets] list failed:", error.message);
    return c.json({ error: "Could not load your tickets." }, 500);
  }
  return c.json({ tickets: data ?? [] });
});

// ── POST / — open a new ticket (subject + first message) ─────────────────────
supportTicketRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  let body: { subject?: unknown; body?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const subject = typeof body.subject === "string"
    ? body.subject.trim().slice(0, MAX_SUBJECT_CHARS)
    : "";
  const message = typeof body.body === "string"
    ? body.body.trim().slice(0, MAX_BODY_CHARS)
    : "";
  if (!subject) return c.json({ error: "A subject is required." }, 400);
  if (!message) return c.json({ error: "A message is required." }, 400);

  const nowIso = new Date().toISOString();
  const { data: ticket, error: tErr } = await supabaseAdmin
    .from("support_tickets")
    .insert({
      user_id: userId,
      subject,
      status: "open",
      last_message_at: nowIso,
    } as never)
    .select("id")
    .maybeSingle();
  if (tErr || !ticket) {
    console.error("[support-tickets] create failed:", tErr?.message);
    return c.json({ error: "Could not open the ticket." }, 500);
  }
  const ticketId = (ticket as { id: string }).id;

  const { error: mErr } = await supabaseAdmin
    .from("support_ticket_messages")
    .insert({
      ticket_id: ticketId,
      author_user_id: userId,
      body: message,
      is_internal_note: false,
    } as never);
  if (mErr) {
    console.error("[support-tickets] first message failed:", mErr.message);
    // The ticket row exists; surface success so the user isn't blocked, but log.
  }

  return c.json({ ok: true, ticket_id: ticketId }, 201);
});

// Load a ticket the CALLER owns, or null. Tenant-scoped by user_id.
async function loadOwnedTicket(userId: string, ticketId: string) {
  const { data } = await supabaseAdmin
    .from("support_tickets")
    .select("id, user_id, subject, status, priority, last_message_at, resolved_at, created_at")
    .eq("id", ticketId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as
    | {
      id: string;
      user_id: string;
      subject: string;
      status: string;
      priority: string;
      last_message_at: string;
      resolved_at: string | null;
      created_at: string;
    }
    | null) ?? null;
}

// ── GET /:id — one ticket + its user-visible thread ──────────────────────────
supportTicketRoutes.get("/:id", async (c) => {
  const userId = c.get("userId");
  const ticket = await loadOwnedTicket(userId, c.req.param("id"));
  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  const { data: msgs } = await supabaseAdmin
    .from("support_ticket_messages")
    .select("id, author_user_id, body, is_internal_note, created_at")
    .eq("ticket_id", ticket.id)
    .order("created_at", { ascending: true })
    .limit(500);

  return c.json({
    ticket,
    messages: toUserMessageView((msgs ?? []) as TicketMessageRow[], userId),
  });
});

// ── POST /:id/messages — the user adds a reply ───────────────────────────────
// Reopens a resolved/closed ticket (the user still needs help) and bumps it to
// the top of the admin queue.
supportTicketRoutes.post("/:id/messages", async (c) => {
  const userId = c.get("userId");
  const ticket = await loadOwnedTicket(userId, c.req.param("id"));
  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  let body: { body?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const message = typeof body.body === "string"
    ? body.body.trim().slice(0, MAX_BODY_CHARS)
    : "";
  if (!message) return c.json({ error: "A message is required." }, 400);

  const { error: mErr } = await supabaseAdmin
    .from("support_ticket_messages")
    .insert({
      ticket_id: ticket.id,
      author_user_id: userId,
      body: message,
      is_internal_note: false,
    } as never);
  if (mErr) {
    console.error("[support-tickets] reply failed:", mErr.message);
    return c.json({ error: "Could not send your reply." }, 500);
  }

  // A user reply reopens a resolved/closed ticket; otherwise leave status as-is.
  const nowIso = new Date().toISOString();
  const reopen = ticket.status === "resolved" || ticket.status === "closed";
  await supabaseAdmin
    .from("support_tickets")
    .update(
      (reopen
        ? { status: "open", resolved_at: null, last_message_at: nowIso }
        : { last_message_at: nowIso }) as never,
    )
    .eq("id", ticket.id)
    .eq("user_id", userId);

  return c.json({ ok: true, status: reopen ? "open" : ticket.status });
});
