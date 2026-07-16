// US-898: eBay sync & conflict-resolution console (all tenants).
//
// Mounted at /api/admin/marketplace, inheriting authMiddleware +
// adminAuthMiddleware (admin JWT + AAL2) from the /api/admin/* group in main.ts.
//
//   • GET  /sync-runs    — cross-tenant flipdesk_sync_runs with owner + a STUCK
//                          flag (running past the configurable threshold).
//   • GET  /conflicts    — cross-tenant open flipdesk_sync_conflicts w/ context.
//   • GET  /orphan-sales — cross-tenant flipdesk_ebay_orphan_sales (unmatched eBay
//                          sales), filterable by match_status.
//   • GET  /counts       — badge counts (open conflicts + unmatched orphans +
//                          stuck runs) for the sidebar.
//   • POST /sync-runs/:id/rerun       — re-run a failed sync for its owning tenant
//                                        (reuses triggerEbaySyncForUser).
//   • POST /conflicts/:id/resolve     — accept the eBay or FlipDesk side
//                                        (reuses applyConflictResolutions).
//   • POST /orphan-sales/:id/match    — link an orphan sale to an inventory item
//                                        (reuses matchOrphanSale).
//
// CROSS-TENANT BY DESIGN: an operator-oversight surface gated by
// adminAuthMiddleware, so the GETs deliberately read every tenant's rows. Every
// mutation resolves the owning user_id FROM THE ROW before acting, then the
// reused helper re-scopes all writes to that owner — so a resolution can never
// cross tenants (e.g. an orphan-match can't attach a sale to another tenant's
// item; see lib/orphan-sale-match.ts + the tenant-isolation suite). All three
// mutations are super_admin + MFA step-up + audited.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import { isEbayConfigured } from "../lib/ebay-client.ts";
import {
  getNotificationHealth,
  reconcileNotifications,
  warnOnMissingTopics,
} from "../lib/ebay-notification-subscriptions.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { getSetting } from "../lib/system-settings.ts";
import { isStuckRun } from "../lib/sync-run-lock.ts";
import {
  applyConflictResolutions,
  WINNING_SOURCES,
  type WinningSource,
} from "../lib/sync-conflict-resolve.ts";
import { matchOrphanSale } from "../lib/orphan-sale-match.ts";
import { triggerEbaySyncForUser } from "./flipdesk-ebay.ts";
import { requireScope } from "../lib/scope-guard.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminMarketplaceOpsRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminMarketplaceOpsRoutes.use("*", requireScope("marketplace:write"));

const SETTING_STUCK_MIN = "marketplace_sync_stuck_threshold_min";
const STUCK_MIN_FALLBACK = 15;

const RUN_STATUSES = new Set(["running", "success", "partial", "failed"]);
const ORPHAN_STATUSES = new Set(["unmatched", "matched", "ignored"]);

function pageParams(c: { req: { query: (k: string) => string | undefined } }) {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "25", 10) || 25));
  return { page, limit, from: (page - 1) * limit };
}

// Resolve display emails for a set of owner ids in one query.
async function emailsFor(userIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return map;
  const { data } = await supabaseAdmin.from("users").select("id, email").in("id", ids);
  for (const u of (data ?? []) as Array<{ id: string; email: string | null }>) {
    map.set(u.id, u.email ?? null);
  }
  return map;
}

async function stuckThresholdMs(): Promise<number> {
  const min = await getSetting<number>(SETTING_STUCK_MIN, STUCK_MIN_FALLBACK);
  const n = Number(min);
  return (Number.isFinite(n) && n > 0 ? n : STUCK_MIN_FALLBACK) * 60_000;
}

// ── GET /sync-runs — cross-tenant sync-run history, paginated + stuck-flagged ──
adminMarketplaceOpsRoutes.get("/sync-runs", async (c) => {
  const { page, limit, from } = pageParams(c);
  const statusFilter = c.req.query("status")?.trim() || null; // running|success|partial|failed|stuck

  const now = new Date();
  const thresholdMs = await stuckThresholdMs();
  const stuckCutoffIso = new Date(now.getTime() - thresholdMs).toISOString();

  let q = supabaseAdmin
    .from("flipdesk_sync_runs")
    .select(
      "id, user_id, marketplace, status, listings_total, listings_matched, listings_unmatched, " +
        "sales_new, sales_updated, error_count, errors, started_at, finished_at",
      { count: "exact" },
    );
  if (statusFilter === "stuck") {
    q = q.eq("status", "running").lt("started_at", stuckCutoffIso);
  } else if (statusFilter && RUN_STATUSES.has(statusFilter)) {
    q = q.eq("status", statusFilter);
  }

  const { data, error, count } = await q
    .order("started_at", { ascending: false })
    .range(from, from + limit - 1);
  if (error) {
    return jsonError(c, 500, "Failed to load sync runs");
  }

  type RunRow = {
    id: string;
    user_id: string;
    marketplace: string;
    status: string;
    listings_total: number;
    listings_matched: number;
    listings_unmatched: number;
    sales_new: number;
    sales_updated: number;
    error_count: number;
    errors: unknown;
    started_at: string | null;
    finished_at: string | null;
  };
  const rows = (data ?? []) as unknown as RunRow[];
  const emails = await emailsFor(rows.map((r) => r.user_id));

  const runs = rows.map((r) => ({
    ...r,
    owner_email: emails.get(r.user_id) ?? null,
    stuck: r.status === "running" && isStuckRun(r.started_at, now, thresholdMs),
  }));

  // Summary head-counts so the operator sees the failing/stuck picture at a glance.
  async function countStatus(status: string): Promise<number> {
    const { count: c2 } = await supabaseAdmin
      .from("flipdesk_sync_runs")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    return c2 ?? 0;
  }
  const { count: stuckCount } = await supabaseAdmin
    .from("flipdesk_sync_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "running")
    .lt("started_at", stuckCutoffIso);
  const [running, failed, partial] = await Promise.all([
    countStatus("running"),
    countStatus("failed"),
    countStatus("partial"),
  ]);

  return c.json({
    runs,
    summary: {
      running,
      failed,
      partial,
      stuck: stuckCount ?? 0,
      stuck_threshold_min: Math.round(thresholdMs / 60_000),
    },
    page: { page, limit, total: count ?? runs.length },
  });
});

// ── GET /conflicts — cross-tenant open cross-source conflicts, paginated ──
adminMarketplaceOpsRoutes.get("/conflicts", async (c) => {
  const { page, limit, from } = pageParams(c);

  const { data, error, count } = await supabaseAdmin
    .from("flipdesk_sync_conflicts")
    .select(
      "id, user_id, listing_id, field_name, flipdesk_value, ebay_value, sheets_value, " +
        "suggested_action, detected_at",
      { count: "exact" },
    )
    .is("resolved_at", null)
    .order("detected_at", { ascending: false })
    .range(from, from + limit - 1);
  if (error) {
    return jsonError(c, 500, "Failed to load conflicts");
  }

  type Row = {
    id: string;
    user_id: string;
    listing_id: string;
    field_name: string;
    flipdesk_value: string | null;
    ebay_value: string | null;
    sheets_value: string | null;
    suggested_action: string | null;
    detected_at: string;
  };
  const rows = (data ?? []) as unknown as Row[];

  // Listing context (cross-tenant: ids come from the conflict rows above).
  const listingIds = [...new Set(rows.map((r) => r.listing_id))];
  const listingById = new Map<string, { listing_title: string | null; item_title: string | null }>();
  if (listingIds.length > 0) {
    const { data: listingsRaw } = await supabaseAdmin
      .from("listings")
      .select("id, listing_title, inventory_items(title)")
      .in("id", listingIds);
    for (const l of (listingsRaw ?? []) as unknown as Array<{
      id: string;
      listing_title: string | null;
      inventory_items: { title: string | null } | null;
    }>) {
      listingById.set(l.id, {
        listing_title: l.listing_title,
        item_title: l.inventory_items?.title ?? null,
      });
    }
  }
  const emails = await emailsFor(rows.map((r) => r.user_id));

  const conflicts = rows.map((r) => ({
    ...r,
    owner_email: emails.get(r.user_id) ?? null,
    listing_title: listingById.get(r.listing_id)?.listing_title ?? null,
    item_title: listingById.get(r.listing_id)?.item_title ?? null,
  }));

  return c.json({ conflicts, page: { page, limit, total: count ?? conflicts.length } });
});

// ── GET /orphan-sales — cross-tenant orphan eBay sales, paginated + filterable ──
adminMarketplaceOpsRoutes.get("/orphan-sales", async (c) => {
  const { page, limit, from } = pageParams(c);
  const rawStatus = c.req.query("status")?.trim() || "unmatched";
  const statusFilter = ORPHAN_STATUSES.has(rawStatus) ? rawStatus : null; // null = all

  let q = supabaseAdmin
    .from("flipdesk_ebay_orphan_sales")
    .select(
      "id, user_id, platform_order_id, ebay_item_id, sku, title, sale_price, " +
        "shipping_collected, tax, buyer_username, sold_at, currency, match_status, " +
        "matched_item_id, imported_at",
      { count: "exact" },
    );
  if (statusFilter) q = q.eq("match_status", statusFilter);

  const { data, error, count } = await q
    .order("sold_at", { ascending: false, nullsFirst: false })
    .range(from, from + limit - 1);
  if (error) {
    return jsonError(c, 500, "Failed to load orphan sales");
  }

  type Row = { id: string; user_id: string };
  const rows = (data ?? []) as unknown as Array<Row & Record<string, unknown>>;
  const emails = await emailsFor(rows.map((r) => r.user_id));
  const orphans = rows.map((r) => ({ ...r, owner_email: emails.get(r.user_id) ?? null }));

  return c.json({ orphans, page: { page, limit, total: count ?? orphans.length } });
});

// ── GET /counts — sidebar badge: open conflicts + unmatched orphans + stuck ──
adminMarketplaceOpsRoutes.get("/counts", async (c) => {
  const thresholdMs = await stuckThresholdMs();
  const stuckCutoffIso = new Date(Date.now() - thresholdMs).toISOString();

  const [conflicts, orphans, stuck] = await Promise.all([
    supabaseAdmin
      .from("flipdesk_sync_conflicts")
      .select("id", { count: "exact", head: true })
      .is("resolved_at", null),
    supabaseAdmin
      .from("flipdesk_ebay_orphan_sales")
      .select("id", { count: "exact", head: true })
      .eq("match_status", "unmatched"),
    supabaseAdmin
      .from("flipdesk_sync_runs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running")
      .lt("started_at", stuckCutoffIso),
  ]);

  const openConflicts = conflicts.count ?? 0;
  const unmatchedOrphans = orphans.count ?? 0;
  const stuckRuns = stuck.count ?? 0;
  return c.json({
    open_conflicts: openConflicts,
    unmatched_orphans: unmatchedOrphans,
    stuck_runs: stuckRuns,
    total: openConflicts + unmatchedOrphans + stuckRuns,
  });
});

// ── POST /sync-runs/:id/rerun — re-run a failed sync (super_admin + step-up) ──
adminMarketplaceOpsRoutes.post("/sync-runs/:id/rerun", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to re-run a sync.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const { data: run } = await supabaseAdmin
    .from("flipdesk_sync_runs")
    .select("id, user_id, status")
    .eq("id", id)
    .maybeSingle();
  const runRow = run as { id: string; user_id: string; status: string } | null;
  if (!runRow) return jsonError(c, 404, "Sync run not found");
  if (runRow.status === "running") {
    return jsonError(c, 409, "That sync is still running.");
  }

  // Reuse the same connection-lookup + lock + background-pull path the manual
  // and webhook triggers use, scoped to the run's owning tenant.
  const result = await triggerEbaySyncForUser(runRow.user_id);

  await writeAuditLog(c, {
    action: "marketplace_sync.rerun",
    targetType: "flipdesk_sync_run",
    targetId: id,
    details: { owner_user_id: runRow.user_id, prior_status: runRow.status, result },
  });

  if (result === "no_connection") {
    return jsonError(c, 400, "That seller has no active eBay connection to sync.");
  }
  if (result === "not_configured") {
    return jsonError(c, 503, "eBay is not configured on this server.");
  }
  if (result === "already_running") {
    return jsonError(c, 409, "A sync is already running for that account.");
  }
  return c.json({ ok: true, result });
});

// ── POST /conflicts/:id/resolve — accept eBay or FlipDesk side (super_admin) ──
adminMarketplaceOpsRoutes.post("/conflicts/:id/resolve", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to resolve a conflict.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  let body: { source?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const source = typeof body.source === "string" ? body.source : null;
  if (!source || !WINNING_SOURCES.has(source)) {
    return jsonError(c, 400, "source must be flipdesk, ebay or sheets.");
  }

  // Resolve the owning tenant FROM the conflict row, then hand off to the shared
  // helper which re-scopes every write to that owner (US-268).
  const { data: conflict } = await supabaseAdmin
    .from("flipdesk_sync_conflicts")
    .select("id, user_id, resolved_at")
    .eq("id", id)
    .maybeSingle();
  const conflictRow = conflict as
    | { id: string; user_id: string; resolved_at: string | null }
    | null;
  if (!conflictRow) return jsonError(c, 404, "Conflict not found");
  if (conflictRow.resolved_at) {
    return jsonError(c, 409, "Conflict is already resolved.");
  }

  const { resolved, failed } = await applyConflictResolutions(conflictRow.user_id, [
    { conflictId: id, source: source as WinningSource },
  ]);

  await writeAuditLog(c, {
    action: "marketplace_conflict.resolve",
    targetType: "flipdesk_sync_conflict",
    targetId: id,
    details: { owner_user_id: conflictRow.user_id, source, resolved, failed },
  });

  if (resolved === 0) {
    return jsonError(
      c,
      422,
      failed[0]?.error ?? "Could not resolve this conflict.",
    );
  }
  return c.json({ ok: true, resolved });
});

// ── POST /orphan-sales/:id/match — link an orphan to an item (super_admin) ──
adminMarketplaceOpsRoutes.post("/orphan-sales/:id/match", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to match an orphan sale.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  let body: { inventory_item_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const itemId = typeof body.inventory_item_id === "string" ? body.inventory_item_id : null;
  if (!itemId) {
    return jsonError(c, 400, "inventory_item_id is required.");
  }

  // Resolve the owning tenant FROM the orphan row. matchOrphanSale then loads
  // BOTH the orphan and the target item scoped to that owner, so it can never
  // attach a sale to another tenant's item (AC5).
  const { data: orphan } = await supabaseAdmin
    .from("flipdesk_ebay_orphan_sales")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  const orphanRow = orphan as { id: string; user_id: string } | null;
  if (!orphanRow) return jsonError(c, 404, "Orphan sale not found");

  const result = await matchOrphanSale(orphanRow.user_id, id, itemId);

  await writeAuditLog(c, {
    action: "marketplace_orphan_sale.match",
    targetType: "flipdesk_ebay_orphan_sale",
    targetId: id,
    details: {
      owner_user_id: orphanRow.user_id,
      inventory_item_id: itemId,
      ok: result.ok,
      ...(result.ok ? { sale_id: result.sale_id, created: result.created } : { error: result.error }),
    },
  });

  if (!result.ok) {
    const status = result.code === "item_not_found" || result.code === "orphan_not_found"
      ? 404
      : result.code === "already_matched"
        ? 409
        : 422;
    return jsonError(c, status, result.error);
  }
  return c.json({ ok: true, sale_id: result.sale_id, created: result.created });
});

// ── eBay Notification API health + reconcile (US-1964) ────────────────
//
// Inbound sync (sales/payouts/returns) depends on app-level Notification API
// subscriptions that were previously only configurable — and only visible — in
// eBay's developer portal. These two endpoints make that state readable and
// repairable in-app, per environment (sandbox and production are separate eBay
// configs; the reported `env` says which one the running service is bound to).

// GET /notifications — read-only health probe. Which required topic buckets are
// actually subscribed, and to a destination that reaches US. No writes, so it's
// safe for the console to poll.
adminMarketplaceOpsRoutes.get("/notifications", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ configured: false, health: null });
  }
  try {
    const health = await getNotificationHealth();
    // AC4: an unsubscribed topic is warned about on every read, not only by the
    // cron — so it shows up in logs the moment an operator looks at the console.
    warnOnMissingTopics(health, "admin probe");
    return c.json({ configured: true, health });
  } catch (err) {
    return failSafe(
      c,
      502,
      "Couldn't read eBay notification config.",
      err,
      "ebay.notifications.health",
    );
  }
});

// POST /notifications/reconcile — create/update our destinations and subscribe
// every required topic. Idempotent (a healthy config performs zero writes), but
// it DOES mutate the shared, app-wide eBay config for the whole environment, so
// it carries the same super_admin + MFA step-up + audit gate as the other
// mutations on this router.
adminMarketplaceOpsRoutes.post("/notifications/reconcile", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, "Super admin required to reconcile eBay notifications.");
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  if (!isEbayConfigured()) {
    return jsonError(c, 409, "eBay is not configured in this environment.");
  }
  const verificationToken = Deno.env.get("EBAY_VERIFICATION_TOKEN")?.trim();
  if (!verificationToken) {
    // eBay validates a destination by calling our challenge endpoint, which
    // can't answer without this token — so the reconcile would fail anyway.
    return jsonError(
      c,
      409,
      "EBAY_VERIFICATION_TOKEN is not set; eBay cannot validate our webhook endpoints.",
    );
  }

  try {
    const result = await reconcileNotifications({ verificationToken });
    warnOnMissingTopics(result.health, "admin reconcile");

    await writeAuditLog(c, {
      action: "marketplace_notifications.reconcile",
      targetType: "ebay_notification_config",
      targetId: result.env,
      details: {
        env: result.env,
        created: result.created,
        enabled: result.enabled,
        repointed: result.repointed,
        already_current: result.alreadyCurrent,
        missing_buckets: result.health.missingBuckets,
        errors: result.errors,
      },
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return failSafe(
      c,
      502,
      "Couldn't reconcile eBay notifications.",
      err,
      "ebay.notifications.reconcile",
    );
  }
});
