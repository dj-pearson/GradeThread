// US-899: cross-tenant listing/AutoLister pipeline oversight (all tenants).
//
// Mounted at /api/admin/marketplace/pipeline, inheriting authMiddleware +
// adminAuthMiddleware (admin JWT + AAL2) from the /api/admin/* group in main.ts.
// A platform-wide view of the bulk-listing pipeline so an operator can unstick
// any seller's generation/publish flow:
//
//   • GET  /counts              — backlog summary (feeds the ops-health tile + the
//                                 Marketplace nav badge).
//   • GET  /generation-batches  — failed / partial / stuck AI-generation batches.
//   • GET  /generation-jobs     — failed individual generation jobs w/ context.
//   • GET  /publish-batches     — failed / partial / stuck bulk-publish batches.
//   • GET  /listings            — listings stuck "sending" or with a publish error.
//   • POST /generation-batches/:id/retry  — re-run a batch's incomplete jobs.
//   • POST /generation-batches/:id/cancel — fail a stuck batch's open jobs.
//   • POST /publish-batches/:id/retry     — re-run a publish batch's incomplete jobs.
//   • POST /publish-batches/:id/cancel    — fail a stuck publish batch's open jobs.
//
// CROSS-TENANT BY DESIGN: an operator-oversight surface gated by
// adminAuthMiddleware, so the GETs deliberately read every tenant's rows. Every
// mutation reuses the US-559 durable batch helpers (adminRetry*/adminCancel*),
// which resolve the owning tenant FROM the batch row before re-dispatching — so
// a retry can never run another tenant's work, and the work runs through the
// same bounded worker (PUBLISH_CONCURRENCY / per-item claim + eBay adopt-not-
// duplicate), keeping retries idempotent and within the eBay fan-out bounds
// (US-406/US-464). All four mutations are super_admin + MFA step-up + audited.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import {
  ageMs,
  batchActions,
  isStuckBatch,
  listingPublishState,
  pipelineBacklog,
  STUCK_BATCH_MS,
  STUCK_LISTING_MS,
} from "../lib/pipeline-oversight.ts";
import {
  adminCancelGenerationBatch,
  adminCancelPublishBatch,
  adminRetryGenerationBatch,
  adminRetryPublishBatch,
} from "./flipdesk-autolister.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminMarketplacePipelineRoutes = new Hono<AdminEnv>();

function pageParams(c: { req: { query: (k: string) => string | undefined } }) {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "25", 10) || 25));
  return { page, limit, from: (page - 1) * limit };
}

// Resolve display emails for a set of owner ids in one query.
async function emailsFor(userIds: Array<string | null>): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return map;
  const { data } = await supabaseAdmin.from("users").select("id, email").in("id", ids);
  for (const u of (data ?? []) as Array<{ id: string; email: string | null }>) {
    map.set(u.id, u.email ?? null);
  }
  return map;
}

const BATCH_SELECT =
  "id, user_id, status, item_count, succeeded_count, failed_count, error, created_at, updated_at";

// ── GET / and /counts — backlog summary (the aggregate overview; also feeds the
// ops-health tile + the Marketplace nav badge). Per-source rows (with error +
// age) are server-side paginated under /generation-batches, /generation-jobs,
// /publish-batches and /listings. ──
// deno-lint-ignore no-explicit-any
async function handleCounts(c: any) {
  const now = new Date();
  const batchCutoff = new Date(now.getTime() - STUCK_BATCH_MS).toISOString();
  const listingCutoff = new Date(now.getTime() - STUCK_LISTING_MS).toISOString();

  const head = { count: "exact" as const, head: true };
  const [
    fgb,
    sgb,
    fgj,
    fpb,
    spb,
    fl,
    sl,
  ] = await Promise.all([
    supabaseAdmin.from("listing_generation_batches").select("id", head).in("status", ["failed", "partial"]),
    supabaseAdmin.from("listing_generation_batches").select("id", head).in("status", ["running", "pending"]).lt("updated_at", batchCutoff),
    supabaseAdmin.from("listing_generation_jobs").select("id", head).eq("status", "failed"),
    supabaseAdmin.from("listing_publish_batches").select("id", head).in("status", ["failed", "partial"]),
    supabaseAdmin.from("listing_publish_batches").select("id", head).in("status", ["running", "pending"]).lt("updated_at", batchCutoff),
    supabaseAdmin.from("listings").select("id", head).eq("listing_status", "draft").is("synced_to_ebay_at", null).not("publish_error", "is", null),
    supabaseAdmin.from("listings").select("id", head).eq("listing_status", "draft").is("synced_to_ebay_at", null).is("publish_error", null).lt("publish_claimed_at", listingCutoff),
  ]);

  const counts = {
    failedGenerationBatches: fgb.count ?? 0,
    stuckGenerationBatches: sgb.count ?? 0,
    failedGenerationJobs: fgj.count ?? 0,
    failedPublishBatches: fpb.count ?? 0,
    stuckPublishBatches: spb.count ?? 0,
    failedListings: fl.count ?? 0,
    stuckListings: sl.count ?? 0,
  };
  return c.json({ ...counts, total: pipelineBacklog(counts), stuck_threshold_min: STUCK_BATCH_MS / 60_000 });
}

adminMarketplacePipelineRoutes.get("/", handleCounts);
adminMarketplacePipelineRoutes.get("/counts", handleCounts);

// ── GET /generation-batches — failed / partial / stuck generation batches ──
adminMarketplacePipelineRoutes.get("/generation-batches", (c) =>
  listBatches(c, "listing_generation_batches", "generation"));

// ── GET /publish-batches — failed / partial / stuck publish batches ──
adminMarketplacePipelineRoutes.get("/publish-batches", (c) =>
  listBatches(c, "listing_publish_batches", "publish"));

async function listBatches(
  // deno-lint-ignore no-explicit-any
  c: any,
  table: "listing_generation_batches" | "listing_publish_batches",
  kind: "generation" | "publish",
) {
  const { page, limit, from } = pageParams(c);
  const now = new Date();
  const batchCutoff = new Date(now.getTime() - STUCK_BATCH_MS).toISOString();

  // Failed/partial OR (running/pending AND stale) — the pipeline-issue set.
  const { data, error, count } = await supabaseAdmin
    .from(table)
    .select(BATCH_SELECT, { count: "exact" })
    .or(`status.in.(failed,partial),and(status.in.(running,pending),updated_at.lt.${batchCutoff})`)
    .order("updated_at", { ascending: false })
    .range(from, from + limit - 1);
  if (error) return jsonError(c, 500, "Failed to load batches");

  type Row = {
    id: string;
    user_id: string;
    status: string;
    item_count: number;
    succeeded_count: number;
    failed_count: number;
    error: string | null;
    created_at: string;
    updated_at: string | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  const emails = await emailsFor(rows.map((r) => r.user_id));

  const batches = rows.map((r) => {
    const stuck = isStuckBatch(r.status, r.updated_at, now);
    const { canRetry, canCancel } = batchActions(
      r.status,
      r.item_count,
      r.succeeded_count,
      r.failed_count,
      stuck,
    );
    return {
      kind,
      id: r.id,
      user_id: r.user_id,
      owner_email: emails.get(r.user_id) ?? null,
      status: r.status,
      item_count: r.item_count,
      succeeded_count: r.succeeded_count,
      failed_count: r.failed_count,
      error: r.error,
      created_at: r.created_at,
      updated_at: r.updated_at,
      age_ms: ageMs(r.updated_at ?? r.created_at, now),
      stuck,
      can_retry: canRetry,
      can_cancel: canCancel,
    };
  });

  return c.json({ batches, page: { page, limit, total: count ?? batches.length } });
}

// ── GET /generation-jobs — failed individual jobs with batch + item context ──
adminMarketplacePipelineRoutes.get("/generation-jobs", async (c) => {
  const { page, limit, from } = pageParams(c);
  const now = new Date();

  const { data, error, count } = await supabaseAdmin
    .from("listing_generation_jobs")
    .select(
      "id, batch_id, inventory_item_id, status, error, attempts, created_at, updated_at, " +
        "listing_generation_batches(user_id, status), inventory_items(title)",
      { count: "exact" },
    )
    .eq("status", "failed")
    .order("updated_at", { ascending: false })
    .range(from, from + limit - 1);
  if (error) return jsonError(c, 500, "Failed to load generation jobs");

  type Row = {
    id: string;
    batch_id: string;
    inventory_item_id: string;
    status: string;
    error: string | null;
    attempts: number;
    created_at: string;
    updated_at: string | null;
    listing_generation_batches: { user_id: string; status: string } | null;
    inventory_items: { title: string | null } | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  const emails = await emailsFor(rows.map((r) => r.listing_generation_batches?.user_id ?? null));

  const jobs = rows.map((r) => {
    const ownerId = r.listing_generation_batches?.user_id ?? null;
    return {
      id: r.id,
      batch_id: r.batch_id,
      batch_status: r.listing_generation_batches?.status ?? null,
      inventory_item_id: r.inventory_item_id,
      item_title: r.inventory_items?.title ?? null,
      user_id: ownerId,
      owner_email: ownerId ? emails.get(ownerId) ?? null : null,
      status: r.status,
      error: r.error,
      attempts: r.attempts,
      created_at: r.created_at,
      updated_at: r.updated_at,
      age_ms: ageMs(r.updated_at ?? r.created_at, now),
    };
  });

  return c.json({ jobs, page: { page, limit, total: count ?? jobs.length } });
});

// ── GET /listings — listings stuck "sending" or with a publish error ──
adminMarketplacePipelineRoutes.get("/listings", async (c) => {
  const { page, limit, from } = pageParams(c);
  const now = new Date();
  const listingCutoff = new Date(now.getTime() - STUCK_LISTING_MS).toISOString();

  const { data, error, count } = await supabaseAdmin
    .from("listings")
    .select(
      "id, user_id, listing_title, listing_status, publish_error, publish_failed_at, " +
        "publish_claimed_at, synced_to_ebay_at, inventory_item_id, created_at, updated_at, " +
        "inventory_items(title)",
      { count: "exact" },
    )
    .eq("listing_status", "draft")
    .is("synced_to_ebay_at", null)
    .or(`publish_error.not.is.null,publish_claimed_at.lt.${listingCutoff}`)
    .order("updated_at", { ascending: false })
    .range(from, from + limit - 1);
  if (error) return jsonError(c, 500, "Failed to load listings");

  type Row = {
    id: string;
    user_id: string;
    listing_title: string | null;
    listing_status: string;
    publish_error: string | null;
    publish_failed_at: string | null;
    publish_claimed_at: string | null;
    synced_to_ebay_at: string | null;
    inventory_item_id: string | null;
    created_at: string;
    updated_at: string | null;
    inventory_items: { title: string | null } | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  const emails = await emailsFor(rows.map((r) => r.user_id));

  const listings = rows
    .map((r) => {
      const state = listingPublishState(r, now);
      if (!state) return null; // claim not yet stale → not actually an issue
      return {
        id: r.id,
        user_id: r.user_id,
        owner_email: emails.get(r.user_id) ?? null,
        listing_title: r.listing_title ?? r.inventory_items?.title ?? null,
        inventory_item_id: r.inventory_item_id,
        state,
        publish_error: r.publish_error,
        publish_failed_at: r.publish_failed_at,
        publish_claimed_at: r.publish_claimed_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
        age_ms: ageMs(r.publish_failed_at ?? r.publish_claimed_at ?? r.updated_at, now),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return c.json({ listings, page: { page, limit, total: count ?? listings.length } });
});

// ── Mutations: retry / cancel a batch (super_admin + step-up + audited) ──

// deno-lint-ignore no-explicit-any
function guardSuperAdmin(c: any, verb: string): Response | null {
  if (c.get("adminRole") !== "super_admin") {
    return jsonError(c, 403, `Super admin required to ${verb}.`);
  }
  return requireStepUp(c);
}

// deno-lint-ignore no-explicit-any
async function readReason(c: any): Promise<string> {
  try {
    const body = (await c.req.json()) as { reason?: unknown };
    return typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  } catch {
    return "";
  }
}

adminMarketplacePipelineRoutes.post("/generation-batches/:id/retry", async (c) => {
  const guard = guardSuperAdmin(c, "retry a generation batch");
  if (guard) return guard;
  const id = c.req.param("id");
  const result = await adminRetryGenerationBatch(id);
  await writeAuditLog(c, {
    action: "pipeline_generation_batch.retry",
    targetType: "listing_generation_batch",
    targetId: id,
    details: { ok: result.ok, retried: result.retried ?? 0, ...(result.error ? { error: result.error } : {}) },
  });
  if (!result.ok) return jsonError(c, 422, result.error ?? "Retry failed");
  return c.json({ ok: true, retried: result.retried ?? 0 });
});

adminMarketplacePipelineRoutes.post("/generation-batches/:id/cancel", async (c) => {
  const guard = guardSuperAdmin(c, "cancel a generation batch");
  if (guard) return guard;
  const id = c.req.param("id");
  const reason = (await readReason(c)) || "Cancelled by admin";
  const result = await adminCancelGenerationBatch(id, reason);
  await writeAuditLog(c, {
    action: "pipeline_generation_batch.cancel",
    targetType: "listing_generation_batch",
    targetId: id,
    details: { reason, ok: result.ok, cancelled: result.cancelled ?? 0, ...(result.error ? { error: result.error } : {}) },
  });
  if (!result.ok) return jsonError(c, 422, result.error ?? "Cancel failed");
  return c.json({ ok: true, cancelled: result.cancelled ?? 0 });
});

adminMarketplacePipelineRoutes.post("/publish-batches/:id/retry", async (c) => {
  const guard = guardSuperAdmin(c, "retry a publish batch");
  if (guard) return guard;
  const id = c.req.param("id");
  const result = await adminRetryPublishBatch(id);
  await writeAuditLog(c, {
    action: "pipeline_publish_batch.retry",
    targetType: "listing_publish_batch",
    targetId: id,
    details: { ok: result.ok, retried: result.retried ?? 0, ...(result.error ? { error: result.error } : {}) },
  });
  if (!result.ok) return jsonError(c, 422, result.error ?? "Retry failed");
  return c.json({ ok: true, retried: result.retried ?? 0 });
});

adminMarketplacePipelineRoutes.post("/publish-batches/:id/cancel", async (c) => {
  const guard = guardSuperAdmin(c, "cancel a publish batch");
  if (guard) return guard;
  const id = c.req.param("id");
  const reason = (await readReason(c)) || "Cancelled by admin";
  const result = await adminCancelPublishBatch(id, reason);
  await writeAuditLog(c, {
    action: "pipeline_publish_batch.cancel",
    targetType: "listing_publish_batch",
    targetId: id,
    details: { reason, ok: result.ok, cancelled: result.cancelled ?? 0, ...(result.error ? { error: result.error } : {}) },
  });
  if (!result.ok) return jsonError(c, 422, result.error ?? "Cancel failed");
  return c.json({ ok: true, cancelled: result.cancelled ?? 0 });
});
