import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";

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

// US-2525 — image attachments.
//
// Support is where someone goes when a photo came out wrong or a screen showed
// something they cannot describe, and the thread took text only. Files go
// through the US-276 path — validateImageUpload (magic bytes, not the client's
// claim) then stripImageMetadata (EXIF and GPS, which a support screenshot can
// carry) then upload — into the user's own folder in the PRIVATE
// submission-images bucket. Reads are short-lived signed URLs; never a public
// one.

/** Per message. Enough for a before/after plus a screenshot, not a photo dump. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 3;

/** Signed-URL lifetime. US-276 caps this at 900s for the private bucket. */
export const ATTACHMENT_URL_TTL_SEC = 600;

export interface StoredAttachment {
  path: string;
  name: string;
  content_type: string;
  bytes: number;
}

/** `data:image/png;base64,…` → raw bytes. Null when it is not that. */
export function decodeImageDataUrl(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (!match) return null;
  try {
    const binary = atob(match[1]!.replace(/\s/g, ""));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Keeps a user-supplied filename readable without letting it steer a path. The
 * name is only ever displayed — the storage path is built separately — but a
 * name carrying `..` or a slash reads as a traversal attempt to the next person
 * who looks at it, so both are flattened here.
 */
export function safeAttachmentName(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const cleaned = raw
    .replace(/\.{2,}/g, "_") // no ".." anywhere
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_") // collapse the runs that produces
    .replace(/^[._-]+/, "") // and no leading dot, dash or underscore
    .slice(0, 80);
  return cleaned || "attachment";
}

/**
 * Storage path for one attachment. Starts with the OWNER's id because the
 * bucket's RLS policy is `(storage.foldername(name))[1] = auth.uid()::text` —
 * a path built any other way would be unreadable by the person who uploaded it.
 */
export function attachmentPath(
  userId: string,
  ticketId: string,
  ext: string,
  now: number,
  index: number,
): string {
  return `${userId}/support/${ticketId}/${now}_${index}.${ext}`;
}

/**
 * Validate, strip and store the attachments on one message. Returns the rows to
 * persist, or an error string for the caller to surface. All-or-nothing: a
 * message that half-uploaded would show the user an attachment count it cannot
 * honour.
 */
async function storeAttachments(
  userId: string,
  ticketId: string,
  raw: unknown,
): Promise<{ ok: true; attachments: StoredAttachment[] } | { ok: false; error: string }> {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Attachments must be a list." };
  if (raw.length === 0) return { ok: true, attachments: [] };
  if (raw.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      ok: false,
      error: `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`,
    };
  }

  const now = Date.now();
  const stored: StoredAttachment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as { data_url?: unknown; name?: unknown };
    const bytes = decodeImageDataUrl(item?.data_url);
    if (!bytes) return { ok: false, error: "One attachment was not an image." };

    const verdict = validateImageUpload(bytes, { allow: ["jpeg", "png", "webp"] });
    if (!verdict.ok) {
      return { ok: false, error: `Attachment rejected: ${verdict.reason}` };
    }
    const { bytes: clean } = stripImageMetadata(bytes, verdict.format);
    const path = attachmentPath(userId, ticketId, verdict.ext, now, i);
    const { error: upErr } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(path, clean, { contentType: verdict.contentType, upsert: false });
    if (upErr) {
      console.error("[support-tickets] attachment upload failed:", upErr.message);
      return { ok: false, error: "Could not store that attachment." };
    }
    stored.push({
      path,
      name: safeAttachmentName(item?.name),
      content_type: verdict.contentType,
      bytes: clean.byteLength,
    });
  }
  return { ok: true, attachments: stored };
}

/** Signed URLs for a thread's attachments. A failure drops the URL, not the message. */
async function signAttachments(
  attachments: StoredAttachment[],
): Promise<Array<StoredAttachment & { url: string | null }>> {
  const out: Array<StoredAttachment & { url: string | null }> = [];
  for (const a of attachments) {
    const { data } = await supabaseAdmin.storage
      .from("submission-images")
      .createSignedUrl(a.path, ATTACHMENT_URL_TTL_SEC);
    out.push({ ...a, url: data?.signedUrl ?? null });
  }
  return out;
}

// A message row as stored. Exported so the unit test can exercise the
// user-visibility projection without a live DB.
export interface TicketMessageRow {
  id: string;
  author_user_id: string | null;
  body: string;
  is_internal_note: boolean;
  created_at: string;
  attachments?: StoredAttachment[] | null;
}

export interface UserMessageView {
  id: string;
  author: "you" | "support";
  body: string;
  created_at: string;
  attachments: StoredAttachment[];
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
      // US-2525: an internal note's attachments are dropped with the note
      // itself, since the filter above runs first.
      attachments: m.attachments ?? [],
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

  let body: { subject?: unknown; body?: unknown; attachments?: unknown };
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

  // US-2525: the attachments land AFTER the ticket row, because their storage
  // path carries the ticket id. A rejected attachment fails the whole request
  // rather than silently opening a ticket without the screenshot it was about.
  const uploaded = await storeAttachments(userId, ticketId, body.attachments);
  if (!uploaded.ok) return c.json({ error: uploaded.error }, 400);

  const { error: mErr } = await supabaseAdmin
    .from("support_ticket_messages")
    .insert({
      ticket_id: ticketId,
      author_user_id: userId,
      body: message,
      is_internal_note: false,
      attachments: uploaded.attachments,
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
    .select("id, author_user_id, body, is_internal_note, created_at, attachments")
    .eq("ticket_id", ticket.id)
    .order("created_at", { ascending: true })
    .limit(500);

  // US-2525: signed URLs, minted per read and short-lived. The bucket is
  // private, so a public URL is never minted for it (US-276).
  const messages = toUserMessageView((msgs ?? []) as TicketMessageRow[], userId);
  const withUrls = [];
  for (const m of messages) {
    withUrls.push({
      ...m,
      attachments: m.attachments.length > 0
        ? await signAttachments(m.attachments)
        : [],
    });
  }

  return c.json({ ticket, messages: withUrls });
});

// ── POST /:id/messages — the user adds a reply ───────────────────────────────
// Reopens a resolved/closed ticket (the user still needs help) and bumps it to
// the top of the admin queue.
supportTicketRoutes.post("/:id/messages", async (c) => {
  const userId = c.get("userId");
  const ticket = await loadOwnedTicket(userId, c.req.param("id"));
  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  let body: { body?: unknown; attachments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const message = typeof body.body === "string"
    ? body.body.trim().slice(0, MAX_BODY_CHARS)
    : "";
  if (!message) return c.json({ error: "A message is required." }, 400);

  const uploaded = await storeAttachments(userId, ticket.id, body.attachments);
  if (!uploaded.ok) return c.json({ error: uploaded.error }, 400);

  const { error: mErr } = await supabaseAdmin
    .from("support_ticket_messages")
    .insert({
      ticket_id: ticket.id,
      author_user_id: userId,
      body: message,
      is_internal_note: false,
      attachments: uploaded.attachments,
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

// ── POST /:id/close — the user closes their own ticket ───────────────────────
//
// US-2525: a user could open a ticket and reply to it, but never say "sorted,
// thanks" — only an admin could. So the queue carried resolved conversations
// nobody had marked resolved, and the user had no way to stop one.
//
// 'closed', not 'resolved': resolved is the OPERATOR's verdict that the problem
// was fixed, and letting a user set it would quietly overwrite support's own
// record of what happened. A reply reopens it either way.
supportTicketRoutes.post("/:id/close", async (c) => {
  const userId = c.get("userId");
  const ticket = await loadOwnedTicket(userId, c.req.param("id"));
  if (!ticket) return c.json({ error: "Ticket not found" }, 404);
  if (ticket.status === "closed") return c.json({ ok: true, status: "closed" });

  const { error } = await supabaseAdmin
    .from("support_tickets")
    .update({ status: "closed" } as never)
    .eq("id", ticket.id)
    .eq("user_id", userId);
  if (error) {
    console.error("[support-tickets] close failed:", error.message);
    return c.json({ error: "Could not close the ticket." }, 500);
  }
  return c.json({ ok: true, status: "closed" });
});
