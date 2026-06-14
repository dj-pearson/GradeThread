// US-897: Marketplace connection health console (all tenants).
//
// Mounted at /api/admin/marketplace-connections, inheriting authMiddleware +
// adminAuthMiddleware (admin JWT + AAL2) from the /api/admin/* group in main.ts.
//
//   • GET  /                  — cross-tenant list of marketplace_connections with
//                               derived health (healthy/expiring/error/inactive),
//                               server-side paginated + filterable by health and
//                               marketplace, plus a health summary. Admin-level
//                               (read-only). Encrypted tokens are NEVER selected
//                               or returned (AC2).
//   • POST /:id/refresh       — trigger a token refresh for the connection's
//                               owner, reusing the existing AES-GCM refresh logic
//                               (getUserAccessToken / getDepopAccessToken) — never
//                               reimplementing crypto. super_admin + step-up +
//                               audited.
//   • POST /:id/flag-reconnect — soft-flag a connection and notify its owner to
//                               re-authorize, via the in-app messaging system.
//                               super_admin + step-up + audited.
//
// CROSS-TENANT BY DESIGN: this is an operator oversight surface gated by
// adminAuthMiddleware, so (unlike the multi-tenant user routes covered by the
// CLAUDE.md US-268 explicit-scoping rule) it deliberately reads every tenant's
// connections. Mutations resolve the owning user_id from the row before acting.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { notifyUser } from "../lib/notify.ts";
import { getUserAccessToken } from "../lib/ebay-client.ts";
import { getDepopAccessToken } from "../lib/depop-client.ts";
import {
  type ConnectionHealth,
  EXPIRING_WINDOW_MS,
  type RawConnectionRow,
  toConnectionHealth,
  VALID_HEALTH,
} from "../lib/marketplace-health.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminMarketplaceConnectionsRoutes = new Hono<AdminEnv>();

// Non-token columns ONLY — the encrypted access/refresh tokens are never selected
// so they can't leak out of this console (AC2).
const CONNECTION_SELECT =
  "id, user_id, marketplace, account_handle, token_expires_at, last_synced_at, last_refresh_attempt_at, refresh_error, is_active, created_at, updated_at";

// Human label per marketplace enum value (the edge has no frontend constants).
const MARKETPLACE_LABELS: Record<string, string> = {
  ebay: "eBay",
  poshmark: "Poshmark",
  mercari: "Mercari",
  depop: "Depop",
  grailed: "Grailed",
  facebook: "Facebook",
  offerup: "OfferUp",
  shopify: "Shopify",
  whatnot: "Whatnot",
  other: "marketplace",
};

const RECONNECT_REQUESTED_MESSAGE =
  "Reconnection requested by support — please re-authorize this connection.";

// ── GET / — cross-tenant connection health, paginated + summarized ──
adminMarketplaceConnectionsRoutes.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "25", 10) || 25));
  const from = (page - 1) * limit;

  const rawHealth = c.req.query("health");
  const healthFilter: ConnectionHealth | null =
    rawHealth && VALID_HEALTH.has(rawHealth as ConnectionHealth)
      ? (rawHealth as ConnectionHealth)
      : null;
  const marketplace = c.req.query("marketplace")?.trim() || null;

  const now = Date.now();
  const expiringIso = new Date(now + EXPIRING_WINDOW_MS).toISOString();

  // Count rows of a given health (mutually exclusive + exhaustive over the
  // marketplace-filtered set). Builds its own head-only query so no query
  // builder has to be threaded through a helper.
  async function countHealth(h: ConnectionHealth): Promise<number> {
    let q = supabaseAdmin
      .from("marketplace_connections")
      .select("id", { count: "exact", head: true });
    if (marketplace) q = q.eq("marketplace", marketplace);
    if (h === "error") q = q.not("refresh_error", "is", null);
    else if (h === "inactive") q = q.eq("is_active", false).is("refresh_error", null);
    else if (h === "expiring") {
      q = q
        .eq("is_active", true)
        .is("refresh_error", null)
        .or(`token_expires_at.is.null,token_expires_at.lte.${expiringIso}`);
    } else if (h === "healthy") {
      q = q.eq("is_active", true).is("refresh_error", null).gt("token_expires_at", expiringIso);
    }
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  let healthy: number, expiring: number, errored: number, inactive: number;
  try {
    [healthy, expiring, errored, inactive] = await Promise.all([
      countHealth("healthy"),
      countHealth("expiring"),
      countHealth("error"),
      countHealth("inactive"),
    ]);
  } catch (err) {
    console.error("[admin-marketplace-connections] summary failed:", err);
    return jsonError(c, 500, "Failed to load connection health summary");
  }

  const summary = {
    total: healthy + expiring + errored + inactive,
    healthy,
    expiring,
    error: errored,
    inactive,
  };

  // The paginated list, applying the same health filter.
  let dq = supabaseAdmin.from("marketplace_connections").select(CONNECTION_SELECT);
  if (marketplace) dq = dq.eq("marketplace", marketplace);
  if (healthFilter === "error") dq = dq.not("refresh_error", "is", null);
  else if (healthFilter === "inactive") {
    dq = dq.eq("is_active", false).is("refresh_error", null);
  } else if (healthFilter === "expiring") {
    dq = dq
      .eq("is_active", true)
      .is("refresh_error", null)
      .or(`token_expires_at.is.null,token_expires_at.lte.${expiringIso}`);
  } else if (healthFilter === "healthy") {
    dq = dq.eq("is_active", true).is("refresh_error", null).gt("token_expires_at", expiringIso);
  }

  const { data, error } = await dq
    // Soonest-to-expire (and unknown-expiry) first so the at-risk connections
    // bubble to the top.
    .order("token_expires_at", { ascending: true, nullsFirst: true })
    .order("updated_at", { ascending: false })
    .range(from, from + limit - 1);
  if (error) {
    console.error("[admin-marketplace-connections] list failed:", error.message);
    return jsonError(c, 500, "Failed to load connections");
  }

  const connections = ((data ?? []) as RawConnectionRow[]).map((row) =>
    toConnectionHealth(row, now)
  );

  const total = healthFilter ? summary[healthFilter] : summary.total;

  return c.json({
    connections,
    summary,
    page: { page, limit, total },
  });
});

// Load the owning user + marketplace for a connection id (cross-tenant: this is
// the admin oversight surface). Returns null if it doesn't exist.
async function loadConnection(id: string) {
  const { data } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, user_id, marketplace, account_handle")
    .eq("id", id)
    .maybeSingle();
  return (data as
    | { id: string; user_id: string; marketplace: string; account_handle: string | null }
    | null) ?? null;
}

// ── POST /:id/refresh — trigger a token refresh (super_admin + step-up + audit) ──
adminMarketplaceConnectionsRoutes.post("/:id/refresh", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to refresh a connection.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const conn = await loadConnection(id);
  if (!conn) return jsonError(c, 404, "Connection not found");

  let ok = true;
  let refreshError: string | null = null;
  // Reuse the existing AES-GCM refresh-and-persist logic (which also clears /
  // records refresh_error) instead of reimplementing crypto (AC5). These operate
  // on the owner's active connection for that marketplace.
  try {
    if (conn.marketplace === "ebay") await getUserAccessToken(conn.user_id);
    else if (conn.marketplace === "depop") await getDepopAccessToken(conn.user_id);
    else {
      return jsonError(
        c,
        400,
        `Token refresh isn't supported for ${MARKETPLACE_LABELS[conn.marketplace] ?? conn.marketplace}. Use flag-for-reconnect to ask the seller to re-authorize.`,
      );
    }
  } catch (err) {
    ok = false;
    refreshError = err instanceof Error ? err.message : String(err);
  }

  await writeAuditLog(c, {
    action: "marketplace_connection.refresh",
    targetType: "marketplace_connection",
    targetId: id,
    details: {
      marketplace: conn.marketplace,
      account_handle: conn.account_handle,
      owner_user_id: conn.user_id,
      ok,
      error: refreshError,
    },
  });

  if (!ok) {
    return jsonError(c, 502, `Refresh failed: ${refreshError ?? "unknown error"}`);
  }
  return c.json({ ok: true });
});

// ── POST /:id/flag-reconnect — notify owner to re-authorize (super_admin + step-up + audit) ──
adminMarketplaceConnectionsRoutes.post("/:id/flag-reconnect", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to flag a connection.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const conn = await loadConnection(id);
  if (!conn) return jsonError(c, 404, "Connection not found");

  const label = MARKETPLACE_LABELS[conn.marketplace] ?? conn.marketplace;

  // Soft-flag: surface a reconnect prompt (so the connection reads as "error"
  // in this console) WITHOUT revoking the token — listings keep syncing until it
  // actually expires. A later successful refresh clears the marker.
  await supabaseAdmin
    .from("marketplace_connections")
    .update({ refresh_error: RECONNECT_REQUESTED_MESSAGE })
    .eq("id", id);

  await notifyUser(conn.user_id, {
    type: "system",
    title: `Reconnect your ${label} account`,
    message:
      `Please reconnect your ${label} connection` +
      (conn.account_handle ? ` (${conn.account_handle})` : "") +
      " so your listings keep syncing.",
    link: "/dashboard/flipdesk/marketplaces",
  });

  await writeAuditLog(c, {
    action: "marketplace_connection.flag_reconnect",
    targetType: "marketplace_connection",
    targetId: id,
    details: {
      marketplace: conn.marketplace,
      account_handle: conn.account_handle,
      owner_user_id: conn.user_id,
    },
  });

  return c.json({ ok: true });
});
