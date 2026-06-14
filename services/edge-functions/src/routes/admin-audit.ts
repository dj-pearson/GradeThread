import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";

// US-905: audit-log export + anomaly triage.
//
// The searchable/filterable LIST is served by the admin_audit_log_search RPC
// (SECURITY DEFINER + is_admin) the SPA calls directly. This route hosts the
// two surfaces that must run server-side:
//   • GET  /export       — CSV/JSON of the filtered set, SUPER-ADMIN only, and
//                          ITSELF audited (who exported what range).
//   • GET  /anomalies     — the anomaly findings the scheduled scan raised
//                          (admin_audit_anomalies is service-role-only, so the
//                          SPA cannot read it directly).
//   • POST /anomalies/:id/acknowledge — triage an anomaly (audited).
//
// Mounted at /api/admin/audit, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminAuditRoutes = new Hono<AdminEnv>();

// Hard cap on an export — generous (a full forensic pull) but bounded so a
// single request can't stream an unbounded result set off a busy platform.
const EXPORT_CAP = 50_000;

interface AuditExportRow {
  id: string;
  admin_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

interface ExportFilters {
  search: string | null;
  admin: string | null;
  action: string | null;
  targetType: string | null;
  from: string | null;
  to: string | null;
}

function readFilters(c: Context<AdminEnv>): ExportFilters {
  const q = c.req.query();
  const norm = (v: string | undefined) => {
    const t = (v ?? "").trim();
    return t && t !== "all" ? t : null;
  };
  return {
    search: norm(q.search),
    admin: norm(q.admin),
    action: norm(q.action),
    targetType: norm(q.targetType),
    from: norm(q.from),
    to: norm(q.to),
  };
}

// CSV cell escaping: wrap in quotes and double any embedded quote. Guards
// against CSV injection by prefixing a leading =,+,-,@ with a single quote.
function csvCell(value: unknown): string {
  let s: string;
  if (value == null) s = "";
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(rows: AuditExportRow[]): string {
  const headers = [
    "id",
    "created_at",
    "admin_user_id",
    "actor_role",
    "action",
    "target_type",
    "target_id",
    "ip",
    "user_agent",
    "details",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.created_at,
        r.admin_user_id,
        r.actor_role,
        r.action,
        r.target_type,
        r.target_id,
        r.ip,
        r.user_agent,
        r.details,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

// GET /export?format=csv|json&search=&admin=&action=&targetType=&from=&to=
adminAuditRoutes.get("/export", async (c: Context<AdminEnv>) => {
  // AC4: export is gated to super_admin.
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Audit export is restricted to super admins." }, 403);
  }

  const format = (c.req.query("format") ?? "csv").toLowerCase() === "json"
    ? "json"
    : "csv";
  const f = readFilters(c);

  // Reuse the search RPC (same ILIKE-on-action/target/details logic as the
  // console list) at a high limit. The RPC casts target_id/details to text, so
  // the free-text search works across the jsonb `details` — which a PostgREST
  // `.ilike` on the uuid/jsonb columns cannot do. The RPC's guard accepts the
  // service-role caller (super-admin already enforced by middleware above).
  const { data, error } = await (
    supabaseAdmin as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: (AuditExportRow & { total_count?: number })[] | null; error: { message: string } | null }>;
    }
  ).rpc("admin_audit_log_search", {
    p_search: f.search,
    p_admin: f.admin,
    p_action: f.action,
    p_target_type: f.targetType,
    p_from: f.from,
    p_to: f.to,
    p_limit: EXPORT_CAP,
    p_offset: 0,
  });
  if (error) {
    return c.json({ error: error.message }, 500);
  }
  // Drop the window total_count column from the exported rows.
  const rows: AuditExportRow[] = (data ?? []).map(({ total_count: _t, ...rest }) => rest);

  // AC4: the export is itself audited — who exported what filter set and how
  // many rows. Best-effort; never blocks the download.
  await writeAuditLog(c, {
    action: "audit_log.export",
    targetType: "admin_audit_log",
    targetId: null,
    details: {
      format,
      filters: f,
      row_count: rows.length,
      capped: rows.length >= EXPORT_CAP,
    },
  });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  if (format === "json") {
    return new Response(JSON.stringify(rows, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-log-${stamp}.json"`,
      },
    });
  }
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${stamp}.csv"`,
    },
  });
});

// GET /anomalies?status=open|acknowledged|all&limit=
adminAuditRoutes.get("/anomalies", async (c: Context<AdminEnv>) => {
  const status = (c.req.query("status") ?? "open").toLowerCase();
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 50) || 50, 1),
    200,
  );

  let query = supabaseAdmin
    .from("admin_audit_anomalies")
    .select(
      "id, detector, severity, dedupe_key, actor_user_id, event_count, evidence, alerted, status, first_seen_at, last_seen_at",
    )
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (status === "open" || status === "acknowledged") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);
  const rows = (data ?? []) as Array<{ actor_user_id: string | null }>;

  // Resolve acting-admin labels in one round trip.
  const ids = [
    ...new Set(rows.map((r) => r.actor_user_id).filter((x): x is string => !!x)),
  ];
  const labels = new Map<string, string>();
  if (ids.length > 0) {
    const { data: us } = await supabaseAdmin
      .from("users")
      .select("id, full_name, email")
      .in("id", ids);
    for (const u of (us ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
      labels.set(u.id, u.full_name || u.email || u.id);
    }
  }

  const anomalies = (data ?? []).map((r) => {
    const row = r as { actor_user_id: string | null };
    return {
      ...row,
      actor_label: row.actor_user_id ? labels.get(row.actor_user_id) ?? null : null,
    };
  });
  return c.json({ anomalies });
});

// POST /anomalies/:id/acknowledge — triage a finding (audited).
adminAuditRoutes.post("/anomalies/:id/acknowledge", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const userId = c.get("userId");

  const { data: existing } = await supabaseAdmin
    .from("admin_audit_anomalies")
    .select("id, detector, status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return c.json({ error: "Anomaly not found" }, 404);

  const { error } = await supabaseAdmin
    .from("admin_audit_anomalies")
    .update({
      status: "acknowledged",
      acknowledged_by: userId,
      acknowledged_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 500);

  await writeAuditLog(c, {
    action: "audit_anomaly.acknowledge",
    targetType: "admin_audit_anomaly",
    targetId: id,
    details: { detector: (existing as { detector: string }).detector },
  });

  return c.json({ ok: true });
});
