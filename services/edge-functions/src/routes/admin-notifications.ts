import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { type NotificationType, PREF_KEY } from "../lib/notify.ts";

// US-1058: admin notification event catalog.
//
// Mounted at /api/admin/notifications — inherits authMiddleware +
// adminAuthMiddleware (admin/super_admin + AAL2 MFA) from the /api/admin/*
// group in main.ts. Cross-tenant by design (the catalog spans every user's
// in-app notifications); the admin+MFA gate is the authorization boundary,
// mirroring admin-monitoring.ts.
//
// GET /catalog returns every notification type, the preference category that
// gates it (straight from notify.ts PREF_KEY — the SAME gate used at send time,
// so the catalog reflects the real end-to-end behaviour) and its delivery
// volume, so the operator can see what fires and how often.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminNotificationsRoutes = new Hono<AdminEnv>();

const ALL_TYPES = Object.keys(PREF_KEY) as NotificationType[];

interface CatalogEntry {
  type: NotificationType;
  pref_key: string | null;
  total: number;
  last_30d: number;
}

adminNotificationsRoutes.get("/catalog", async (c) => {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Count rows per type in parallel via head/exact-count queries (no group-by
  // in supabase-js). One pair of cheap COUNT(*) per type.
  const entries = await Promise.all(
    ALL_TYPES.map(async (type): Promise<CatalogEntry> => {
      const [{ count: total }, { count: last30 }] = await Promise.all([
        supabaseAdmin
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("type", type),
        supabaseAdmin
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("type", type)
          .gte("created_at", since),
      ]);
      return {
        type,
        pref_key: PREF_KEY[type],
        total: total ?? 0,
        last_30d: last30 ?? 0,
      };
    }),
  );

  const totalVolume = entries.reduce((sum, e) => sum + e.total, 0);

  return c.json({ catalog: entries, total_volume: totalVolume });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-909: per-admin notification center (distinct from the US-1058 catalog).
//
// The feed is fed by emitOpsEvent() + ticket assignment (lib/admin-notifications
// .ts) — assigned tickets, critical ops events, job failures. Every row is owned
// by an admin (admin_notifications.admin_user_id) and these endpoints are scoped
// to the CALLING admin (c.get("userId")) so views/notifications stay private.
// ─────────────────────────────────────────────────────────────────────────────

const NOTIF_PAGE_SIZE = 30;

interface AdminNotificationRow {
  id: string;
  type: string;
  body: string;
  link: string | null;
  is_read: boolean;
  created_at: string;
}

// GET / — the calling admin's notifications (newest first) + unread count.
// ?unread_only=true limits to unread; ?limit caps the page (default 30, max 50).
adminNotificationsRoutes.get("/", async (c) => {
  const adminId = c.get("userId");
  const unreadOnly = c.req.query("unread_only") === "true";
  const limit = Math.min(
    50,
    Math.max(1, Number(c.req.query("limit") ?? String(NOTIF_PAGE_SIZE)) || NOTIF_PAGE_SIZE),
  );

  let query = supabaseAdmin
    .from("admin_notifications")
    .select("id, type, body, link, is_read, created_at")
    .eq("admin_user_id", adminId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (unreadOnly) query = query.eq("is_read", false);

  const { data, error } = await query;
  if (error) {
    console.error("[admin-notifications] list failed:", error.message);
    return c.json({ error: "Could not load notifications" }, 500);
  }

  const { count: unread } = await supabaseAdmin
    .from("admin_notifications")
    .select("id", { count: "exact", head: true })
    .eq("admin_user_id", adminId)
    .eq("is_read", false);

  return c.json({
    notifications: (data ?? []) as AdminNotificationRow[],
    unread_count: unread ?? 0,
  });
});

// GET /unread-count — cheap poll for the bell badge.
adminNotificationsRoutes.get("/unread-count", async (c) => {
  const { count, error } = await supabaseAdmin
    .from("admin_notifications")
    .select("id", { count: "exact", head: true })
    .eq("admin_user_id", c.get("userId"))
    .eq("is_read", false);
  if (error) return c.json({ unread_count: 0 });
  return c.json({ unread_count: count ?? 0 });
});

// PATCH / — mark notifications read. Body { id } marks one; { all: true } marks
// every unread row. Always scoped to the calling admin so one admin can never
// touch another's feed.
adminNotificationsRoutes.patch("/", async (c) => {
  const adminId = c.get("userId");

  let body: { id?: unknown; all?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (body.all !== true && typeof body.id !== "string") {
    return c.json({ error: "Provide an id or all:true" }, 400);
  }

  let update = supabaseAdmin
    .from("admin_notifications")
    .update({ is_read: true } as never)
    .eq("admin_user_id", adminId)
    .eq("is_read", false);
  if (body.all !== true) update = update.eq("id", body.id as string);

  const { error } = await update;
  if (error) {
    console.error("[admin-notifications] mark-read failed:", error.message);
    return c.json({ error: "Could not update notifications" }, 500);
  }

  const { count } = await supabaseAdmin
    .from("admin_notifications")
    .select("id", { count: "exact", head: true })
    .eq("admin_user_id", adminId)
    .eq("is_read", false);

  return c.json({ ok: true, unread_count: count ?? 0 });
});
