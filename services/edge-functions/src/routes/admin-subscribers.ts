import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { captureException } from "../lib/observability.ts";

// US-912: admin view + CSV export of the standalone newsletter subscriber list.
// Mounted at /api/admin/subscribers, inheriting authMiddleware +
// adminAuthMiddleware (admin JWT + AAL2) from the /api/admin/* group in main.ts.
//
// Viewing/exporting is read-only admin (no super_admin / step-up needed — no
// mutation). Confirmed-only rows are emailable; status is surfaced so an
// operator can see pending/unsubscribed/bounced leads too.
type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminSubscribersRoutes = new Hono<AdminEnv>();

const PAGE_LIMIT = 500;
const EXPORT_LIMIT = 50_000;

type SubscriberStatus = "pending" | "confirmed" | "unsubscribed" | "bounced" | "cleaned";
const STATUSES: SubscriberStatus[] = [
  "pending",
  "confirmed",
  "unsubscribed",
  "bounced",
  "cleaned",
];

function parseStatus(raw: string | undefined): SubscriberStatus | null {
  const s = (raw ?? "").trim().toLowerCase();
  return (STATUSES as string[]).includes(s) ? (s as SubscriberStatus) : null;
}

// GET /api/admin/subscribers?q=&status=&limit= — most-recent first + per-status counts.
adminSubscribersRoutes.get("/", async (c) => {
  const q = c.req.query("q")?.trim().toLowerCase() ?? "";
  const status = parseStatus(c.req.query("status"));
  const limit = Math.min(PAGE_LIMIT, Math.max(1, Number(c.req.query("limit") ?? "200") || 200));

  let query = supabaseAdmin
    .from("email_subscribers")
    .select("email, status, source, user_id, confirmed_at, unsubscribed_at, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (q) query = query.ilike("email", `%${q}%`);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) {
    captureException(error, { route: "admin-subscribers.list" });
    return c.json({ error: "Failed to load subscribers" }, 500);
  }

  // Per-status counts so the admin sees list size / emailable (confirmed) total.
  const counts: Record<string, number> = {};
  for (const s of STATUSES) {
    const { count } = await supabaseAdmin
      .from("email_subscribers")
      .select("id", { count: "exact", head: true })
      .eq("status", s);
    counts[s] = count ?? 0;
  }

  return c.json({ subscribers: data ?? [], counts });
});

// GET /api/admin/subscribers/export?status= — CSV download. Defaults to all; pass
// status=confirmed to export only the emailable list.
adminSubscribersRoutes.get("/export", async (c) => {
  const status = parseStatus(c.req.query("status"));

  let query = supabaseAdmin
    .from("email_subscribers")
    .select("email, status, source, user_id, confirmed_at, unsubscribed_at, created_at")
    .order("created_at", { ascending: false })
    .limit(EXPORT_LIMIT);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) {
    captureException(error, { route: "admin-subscribers.export" });
    return c.json({ error: "Failed to export subscribers" }, 500);
  }

  const rows = (data ?? []) as Array<{
    email: string;
    status: string;
    source: string | null;
    user_id: string | null;
    confirmed_at: string | null;
    unsubscribed_at: string | null;
    created_at: string;
  }>;

  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    // RFC 4180: quote fields containing comma/quote/newline; double embedded quotes.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "email",
    "status",
    "source",
    "linked_user_id",
    "confirmed_at",
    "unsubscribed_at",
    "created_at",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.email,
        r.status,
        r.source ?? "",
        r.user_id ?? "",
        r.confirmed_at ?? "",
        r.unsubscribed_at ?? "",
        r.created_at,
      ]
        .map(esc)
        .join(","),
    );
  }
  const csv = lines.join("\r\n");
  const filename = `subscribers${status ? `-${status}` : ""}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
