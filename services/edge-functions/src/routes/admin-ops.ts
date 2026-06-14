import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { captureException } from "../lib/observability.ts";
import { CRON_REGISTRY } from "../lib/cron-runs.ts";
import {
  aggregateJobStats,
  failingJobCount,
  isRunnableJob,
  manualRunAudit,
  type RawRun,
} from "../lib/ops-jobs.ts";
import {
  BULK_BATCH_LIMIT,
  buildUnifiedPage,
  bulkAudit,
  DEAD_LETTER_WINDOW,
  type DeadLetterSource,
  discardAudit,
  type EmailDeadLetterRow,
  EMAIL_RETRY_BUDGET,
  isDeadLetterSource,
  isWebhookReplayable,
  normalizeDiscardReason,
  parseDeadLetterQuery,
  retryAudit,
  toUnifiedFromEmail,
  toUnifiedFromWebhook,
  type UnifiedDeadLetter,
  type WebhookDeadLetterRow,
} from "../lib/ops-dead-letters.ts";
import { dispatchStripeEvent } from "./webhooks.ts";
import { replayContentWebhook } from "../lib/content-webhook.ts";
import {
  buildHealthReport,
  type EdgeRuntime,
  type HealthMetrics,
  PROCESS_STARTED_AT_MS,
} from "../lib/ops-health.ts";
import { pipelineBacklog, STUCK_BATCH_MS, STUCK_LISTING_MS } from "../lib/pipeline-oversight.ts";
import { releaseSha } from "../lib/observability.ts";
import { edgeEnv } from "../lib/env.ts";
import {
  bustMaintenanceCache,
  isMaintenanceMode,
  isMaintenanceScope,
  MAINTENANCE_SELECT,
  type MaintenanceMode,
  type MaintenanceScope,
  type MaintenanceWindow,
} from "../lib/maintenance.ts";

// Operations console — background jobs & scheduler (US-881).
//
// Mounted at /api/admin/ops — inherits authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts.
//
// GET  /jobs          — the cron registry joined with recent cron_runs stats
//                       (last run, outcome, duration, rolling success rate,
//                       consecutive-failure count, next-due), server-paginated.
// POST /jobs/:key/run — manually fire a job (super_admin + fresh MFA step-up),
//                       guarded by a job_lock and audited. The run goes through
//                       the job's real /api/jobs/* endpoint so the existing
//                       ledger middleware records it (triggered_by=admin:<id>)
//                       and the handler's OWN lock prevents colliding with the
//                       scheduled run.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminOpsRoutes = new Hono<AdminEnv>();

// Bounded recent window pulled for stats. cron_runs is small + pruned daily by
// the data-retention sweep, so this comfortably covers the rolling window for
// every job even at the */5 cadence of the busiest ones.
const RUNS_WINDOW = 4000;

// GET /jobs — registry + recent-run stats, server-side paginated.
adminOpsRoutes.get("/jobs", async (c) => {
  const now = new Date();

  const [{ data: runsRaw }, { data: locksRaw }] = await Promise.all([
    supabaseAdmin
      .from("cron_runs")
      .select("job_name, status, http_status, duration_ms, rows_processed, triggered_by, created_at")
      .order("created_at", { ascending: false })
      .limit(RUNS_WINDOW),
    supabaseAdmin
      .from("job_locks")
      .select("job_name, locked_until"),
  ]);

  // Jobs whose lease is currently held → shown as "running".
  const runningJobs = new Set<string>(
    ((locksRaw ?? []) as Array<{ job_name: string; locked_until: string }>)
      .filter((l) => new Date(l.locked_until).getTime() > now.getTime())
      .map((l) => l.job_name),
  );

  const summaries = aggregateJobStats((runsRaw ?? []) as RawRun[], now, { runningJobs });
  const failing_count = failingJobCount(summaries);

  // Server-side pagination (AC#2). The registry is small, but paginate so the
  // contract holds as jobs grow.
  const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(c.req.query("page_size")) || 50)));
  const total = summaries.length;
  const start = (page - 1) * pageSize;
  const jobs = summaries.slice(start, start + pageSize);

  return c.json({
    jobs,
    page,
    page_size: pageSize,
    total,
    failing_count,
    server_now: now.toISOString(),
  });
});

// POST /jobs/:key/run — manual Run-now. super_admin + fresh MFA step-up.
adminOpsRoutes.post("/jobs/:key/run", async (c) => {
  const key = c.req.param("key");

  // Destructive/privileged: super_admin only, with a fresh second factor.
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  if (!isRunnableJob(key)) {
    return c.json({ error: "Unknown or non-runnable job" }, 404);
  }

  const secret = Deno.env.get("FLIPDESK_INTERNAL_JOB_SECRET");
  if (!secret) {
    return c.json({ error: "Job runner secret not configured" }, 503);
  }

  // Serialize concurrent manual triggers (double-click / two operators) with a
  // short lease on a distinct lock. Collision with the SCHEDULED run is handled
  // separately by the handler's own job_lock (the internal call below re-enters
  // the same handler), so this lock and that one never deadlock each other.
  const lock = await acquireJobLock(`manual-run:${key}`, 180);
  if (!lock.acquired) {
    return c.json({ ok: false, skipped: true, reason: lock.reason }, 409);
  }

  const adminId = c.get("userId");
  const def = CRON_REGISTRY.find((d) => d.name === key)!;

  // Audit the operator's action up front, so intent is recorded even for a
  // long-running job whose outcome we stop awaiting below.
  await writeAuditLog(c, manualRunAudit(key, adminId, def.endpoint));

  try {
    const base = `http://localhost:${Deno.env.get("PORT") || "8787"}`;
    const res = await fetch(`${base}${def.endpoint}`, {
      method: "POST",
      headers: {
        "X-Internal-Job-Secret": secret,
        "X-Triggered-By": `admin:${adminId}`,
      },
      // Operators get synchronous feedback for fast jobs; a slow job keeps
      // running server-side and we return 202 once we stop waiting.
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => ({}));
    return c.json({ ok: res.ok, status: res.status, result: body, job: key });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return c.json({ ok: true, running: true, job: key }, 202);
    }
    captureException(err, { level: "warn", route: "ops.run", tags: { job: key } });
    return c.json({ error: "Job trigger failed" }, 502);
  } finally {
    await lock.release();
  }
});

// ── System health & infrastructure dashboard (US-883) ────────────
//
// GET /health — read-only. Calls the SECURITY DEFINER system_health() RPC for
// the platform-wide aggregates (table sizes/rows, storage usage, queue/DLQ
// depths, job failures + slowest jobs, trends), adds edge process uptime/version
// + a Supabase reachability probe, and turns it all into green/amber/red status
// tiles via the pure ops-health lib (thresholds read from system_settings so
// they're tunable without a deploy). Inherits the /api/admin/* admin gate.
// US-899: cross-tenant listing-pipeline backlog for the health tile. Mirrors the
// /api/admin/marketplace/pipeline/counts query set; summed via the shared pure
// helper so the tile and the Pipeline tab can't disagree.
async function loadPipelineBacklog(): Promise<number> {
  const now = Date.now();
  const batchCutoff = new Date(now - STUCK_BATCH_MS).toISOString();
  const listingCutoff = new Date(now - STUCK_LISTING_MS).toISOString();
  const head = { count: "exact" as const, head: true };
  const [fgb, sgb, fgj, fpb, spb, fl, sl] = await Promise.all([
    supabaseAdmin.from("listing_generation_batches").select("id", head).in("status", ["failed", "partial"]),
    supabaseAdmin.from("listing_generation_batches").select("id", head).in("status", ["running", "pending"]).lt("updated_at", batchCutoff),
    supabaseAdmin.from("listing_generation_jobs").select("id", head).eq("status", "failed"),
    supabaseAdmin.from("listing_publish_batches").select("id", head).in("status", ["failed", "partial"]),
    supabaseAdmin.from("listing_publish_batches").select("id", head).in("status", ["running", "pending"]).lt("updated_at", batchCutoff),
    supabaseAdmin.from("listings").select("id", head).eq("listing_status", "draft").is("synced_to_ebay_at", null).not("publish_error", "is", null),
    supabaseAdmin.from("listings").select("id", head).eq("listing_status", "draft").is("synced_to_ebay_at", null).is("publish_error", null).lt("publish_claimed_at", listingCutoff),
  ]);
  return pipelineBacklog({
    failedGenerationBatches: fgb.count ?? 0,
    stuckGenerationBatches: sgb.count ?? 0,
    failedGenerationJobs: fgj.count ?? 0,
    failedPublishBatches: fpb.count ?? 0,
    stuckPublishBatches: spb.count ?? 0,
    failedListings: fl.count ?? 0,
    stuckListings: sl.count ?? 0,
  });
}

adminOpsRoutes.get("/health", async (c) => {
  // Reachability probe — cheapest "can we reach Postgres?" query, separate from
  // the RPC so a reachable-DB-but-failing-RPC is still reported as reachable.
  const probeStart = Date.now();
  let reachable = false;
  try {
    const { error } = await supabaseAdmin
      .from("users")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    reachable = !error;
  } catch {
    reachable = false;
  }
  const dbLatencyMs = Date.now() - probeStart;

  const runtime: EdgeRuntime = {
    uptimeSeconds: Math.floor((Date.now() - PROCESS_STARTED_AT_MS) / 1000),
    version: releaseSha(),
    env: edgeEnv(),
    supabaseReachable: reachable,
    dbLatencyMs: reachable ? dbLatencyMs : null,
  };

  let metrics: HealthMetrics | null = null;
  try {
    const { data, error } = await supabaseAdmin.rpc("system_health");
    if (error) {
      captureException(error, { tags: { area: "ops-health" } });
    } else if (data) {
      metrics = data as HealthMetrics;
    }
  } catch (err) {
    captureException(err, { tags: { area: "ops-health" } });
  }

  // US-899: fold the cross-tenant listing-pipeline backlog into the report so a
  // failed/stuck generation/publish backlog surfaces on the system-wide health
  // dashboard (not just the Marketplace > Pipeline tab). Best-effort: a failure
  // here leaves the rest of the report intact.
  if (metrics) {
    try {
      metrics.pipeline = { backlog: await loadPipelineBacklog() };
    } catch (err) {
      captureException(err, { tags: { area: "ops-health:pipeline" } });
    }
  }

  // DB unreachable or RPC failed → a minimal red report (don't 500: the
  // dashboard should still render and SHOW the outage rather than erroring out).
  if (!metrics) {
    return c.json({
      overall: "red",
      tiles: [{
        key: "supabase",
        label: "Database",
        status: reachable ? "amber" : "red",
        value: reachable ? "RPC unavailable" : "unreachable",
        detail: reachable
          ? `reachable (${dbLatencyMs} ms) but system_health() failed`
          : "Supabase unreachable",
      }],
      runtime,
      metrics: null,
      thresholds: null,
      generatedAt: new Date().toISOString(),
    });
  }

  return c.json(buildHealthReport(metrics, runtime));
});

// ── Unified dead-letter console (US-882) ─────────────────────────
//
// One cross-provider DLQ over webhook_dead_letters (stripe/ebay/appstore/content
// drops) + email_deliveries in 'dead_letter'. Inspect, retry (re-enqueue through
// the item's normal handler with idempotency preserved), or discard (permanently
// abandon with a required reason). Retry + discard are super_admin + MFA step-up
// and audited; discard requires a reason. Bulk runs a bounded server-side batch.

const WEBHOOK_DLQ_SELECT =
  "id, provider, event_id, event_type, payload, error_message, status, replay_attempts, last_replay_at, created_at";
const EMAIL_DLQ_SELECT =
  "id, recipient, subject, category, status, attempts, max_attempts, last_error, created_at";

// Active = still actionable. A 'resolved'/'discarded' webhook and a
// 'sent'/'discarded' email drop out of the queue.
const WEBHOOK_ACTIVE_STATUS = "unresolved";
const EMAIL_ACTIVE_STATUS = "dead_letter";

async function loadWebhookRow(id: string): Promise<WebhookDeadLetterRow | null> {
  const { data } = await supabaseAdmin
    .from("webhook_dead_letters")
    .select(WEBHOOK_DLQ_SELECT)
    .eq("id", id)
    .maybeSingle();
  return (data as WebhookDeadLetterRow | null) ?? null;
}

async function loadEmailRow(id: string): Promise<EmailDeadLetterRow | null> {
  const { data } = await supabaseAdmin
    .from("email_deliveries")
    .select(EMAIL_DLQ_SELECT)
    .eq("id", id)
    .maybeSingle();
  return (data as EmailDeadLetterRow | null) ?? null;
}

let stripeClient: Stripe | null = null;
function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(key, { apiVersion: "2024-04-10", timeout: 20_000, maxNetworkRetries: 2 });
  }
  return stripeClient;
}

// Re-dispatch a webhook dead letter through its normal handler. Throws on any
// failure (caller leaves the row active + returns an error); marks the row
// 'resolved' on success. Idempotency: Stripe handlers dedupe on the object id,
// so re-running them can't double-apply (see dispatchStripeEvent's note).
async function replayWebhookRow(row: WebhookDeadLetterRow, adminId: string): Promise<void> {
  if (row.provider === "stripe") {
    const stripe = getStripe();
    if (!stripe) throw new Error("STRIPE_SECRET_KEY not configured");
    // Re-pull the authoritative, unredacted event from Stripe (the stored
    // payload is PII-redacted) and re-run the exact handler switch.
    const event = await stripe.events.retrieve(row.event_id);
    await dispatchStripeEvent(event as Stripe.Event);
  } else if (row.provider === "content") {
    const { delivered } = await replayContentWebhook(row.payload);
    if (!delivered) throw new Error("content webhook re-delivery failed");
  } else {
    throw new Error(`Replay not supported for provider ${row.provider}`);
  }

  await supabaseAdmin
    .from("webhook_dead_letters")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: adminId,
      replay_attempts: (row.replay_attempts ?? 0) + 1,
      last_replay_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", WEBHOOK_ACTIVE_STATUS);
}

// Re-enqueue a dead-lettered email back into the outbox. The email-retry cron
// (its normal handler) then re-attempts the SMTP send — no new row is created,
// so there's no duplicate-send risk beyond the outbox's own semantics. Returns
// true when a dead-letter row was actually re-queued.
async function requeueEmailRow(row: EmailDeadLetterRow): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("email_deliveries")
    .update({
      status: "pending",
      next_attempt_at: new Date().toISOString(),
      max_attempts: (row.attempts ?? 0) + EMAIL_RETRY_BUDGET,
      last_error: null,
    })
    .eq("id", row.id)
    .eq("status", EMAIL_ACTIVE_STATUS)
    .select("id")
    .maybeSingle();
  return !!data;
}

async function discardWebhookRow(id: string, reason: string, adminId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("webhook_dead_letters")
    .update({
      status: "discarded",
      resolution_note: reason,
      resolved_at: new Date().toISOString(),
      resolved_by: adminId,
    })
    .eq("id", id)
    .eq("status", WEBHOOK_ACTIVE_STATUS)
    .select("id")
    .maybeSingle();
  return !!data;
}

async function discardEmailRow(id: string, reason: string, adminId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("email_deliveries")
    .update({
      status: "discarded",
      discard_reason: reason,
      discarded_at: new Date().toISOString(),
      discarded_by: adminId,
    })
    .eq("id", id)
    .eq("status", EMAIL_ACTIVE_STATUS)
    .select("id")
    .maybeSingle();
  return !!data;
}

// GET /dead-letters — unified, filterable (source + provider), server-paginated.
adminOpsRoutes.get("/dead-letters", async (c) => {
  const now = new Date();
  const query = parseDeadLetterQuery((k) => c.req.query(k));

  const unified: UnifiedDeadLetter[] = [];

  if (query.source !== "email") {
    const { data: whRows } = await supabaseAdmin
      .from("webhook_dead_letters")
      .select(WEBHOOK_DLQ_SELECT)
      .eq("status", WEBHOOK_ACTIVE_STATUS)
      .order("created_at", { ascending: false })
      .limit(DEAD_LETTER_WINDOW);
    for (const r of (whRows ?? []) as WebhookDeadLetterRow[]) {
      unified.push(toUnifiedFromWebhook(r, now));
    }
  }

  if (query.source !== "webhook") {
    const { data: emRows } = await supabaseAdmin
      .from("email_deliveries")
      .select(EMAIL_DLQ_SELECT)
      .eq("status", EMAIL_ACTIVE_STATUS)
      .order("created_at", { ascending: false })
      .limit(DEAD_LETTER_WINDOW);
    for (const r of (emRows ?? []) as EmailDeadLetterRow[]) {
      unified.push(toUnifiedFromEmail(r, now));
    }
  }

  const page = buildUnifiedPage(unified, query, now);
  return c.json({ ...page, server_now: now.toISOString() });
});

// POST /dead-letters/:source/:id/retry — re-enqueue one item (super_admin + MFA).
adminOpsRoutes.post("/dead-letters/:source/:id/retry", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const source = c.req.param("source");
  const id = c.req.param("id");
  if (!isDeadLetterSource(source)) return c.json({ error: "Unknown source" }, 404);
  const adminId = c.get("userId");

  if (source === "email") {
    const row = await loadEmailRow(id);
    if (!row || row.status !== EMAIL_ACTIVE_STATUS) {
      return c.json({ error: "Dead letter not found or already handled" }, 404);
    }
    await writeAuditLog(c, retryAudit("email", id, row.category));
    const ok = await requeueEmailRow(row);
    return c.json({ ok, source, id, action: "requeued" });
  }

  const row = await loadWebhookRow(id);
  if (!row || row.status !== WEBHOOK_ACTIVE_STATUS) {
    return c.json({ error: "Dead letter not found or already handled" }, 404);
  }
  if (!isWebhookReplayable(row.provider)) {
    return c.json({ error: `Replay not supported for ${row.provider}` }, 422);
  }
  await writeAuditLog(c, retryAudit("webhook", id, row.provider));
  try {
    await replayWebhookRow(row, adminId);
    return c.json({ ok: true, source, id });
  } catch (err) {
    captureException(err, {
      level: "warn",
      route: "ops.dead_letter.retry",
      tags: { provider: row.provider },
      extra: { event_id: row.event_id },
    });
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Replay failed" }, 502);
  }
});

// POST /dead-letters/:source/:id/discard — permanently abandon (reason required).
adminOpsRoutes.post("/dead-letters/:source/:id/discard", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const source = c.req.param("source");
  const id = c.req.param("id");
  if (!isDeadLetterSource(source)) return c.json({ error: "Unknown source" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const reason = normalizeDiscardReason((body as { reason?: unknown }).reason);
  if (!reason) return c.json({ error: "A discard reason is required" }, 400);

  const adminId = c.get("userId");
  const provider = source === "email"
    ? (await loadEmailRow(id))?.category ?? "email"
    : (await loadWebhookRow(id))?.provider ?? "unknown";

  const ok = source === "email"
    ? await discardEmailRow(id, reason, adminId)
    : await discardWebhookRow(id, reason, adminId);
  if (!ok) return c.json({ error: "Dead letter not found or already handled" }, 404);

  await writeAuditLog(c, discardAudit(source, id, provider, reason));
  return c.json({ ok: true, source, id });
});

// POST /dead-letters/bulk — durable, bounded batch over a filtered selection
// (AC#4). Processes at most BULK_BATCH_LIMIT per call and reports how many
// remain, so the client re-issues bounded server-side batches, never a per-item
// client loop.
adminOpsRoutes.post("/dead-letters/bulk", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const body = (await c.req.json().catch(() => ({}))) as {
    action?: unknown;
    source?: unknown;
    provider?: unknown;
    ids?: unknown;
    reason?: unknown;
  };
  const action = body.action === "retry" || body.action === "discard" ? body.action : null;
  if (!action) return c.json({ error: "action must be 'retry' or 'discard'" }, 400);

  const sourceFilter: DeadLetterSource | null = isDeadLetterSource(body.source) ? body.source : null;
  const providerFilter = typeof body.provider === "string" && body.provider.trim()
    ? body.provider.trim()
    : null;
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : null;
  const reason = action === "discard" ? normalizeDiscardReason(body.reason) : null;
  if (action === "discard" && !reason) {
    return c.json({ error: "A discard reason is required for bulk discard" }, 400);
  }

  const adminId = c.get("userId");

  // Gather a bounded candidate set from the applicable table(s).
  const webhookRows: WebhookDeadLetterRow[] = [];
  const emailRows: EmailDeadLetterRow[] = [];

  if (sourceFilter !== "email") {
    let q = supabaseAdmin
      .from("webhook_dead_letters")
      .select(WEBHOOK_DLQ_SELECT)
      .eq("status", WEBHOOK_ACTIVE_STATUS);
    if (providerFilter) q = q.eq("provider", providerFilter);
    if (ids) q = q.in("id", ids);
    const { data } = await q.order("created_at", { ascending: true }).limit(BULK_BATCH_LIMIT);
    webhookRows.push(...((data ?? []) as WebhookDeadLetterRow[]));
  }
  if (sourceFilter !== "webhook" && webhookRows.length < BULK_BATCH_LIMIT) {
    let q = supabaseAdmin
      .from("email_deliveries")
      .select(EMAIL_DLQ_SELECT)
      .eq("status", EMAIL_ACTIVE_STATUS);
    if (providerFilter) q = q.eq("category", providerFilter);
    if (ids) q = q.in("id", ids);
    const { data } = await q
      .order("created_at", { ascending: true })
      .limit(BULK_BATCH_LIMIT - webhookRows.length);
    emailRows.push(...((data ?? []) as EmailDeadLetterRow[]));
  }

  let succeeded = 0;
  let failed = 0;

  for (const row of webhookRows) {
    try {
      if (action === "retry") {
        if (!isWebhookReplayable(row.provider)) { failed++; continue; }
        await replayWebhookRow(row, adminId);
      } else {
        await discardWebhookRow(row.id, reason!, adminId);
      }
      succeeded++;
    } catch (err) {
      failed++;
      captureException(err, { level: "warn", route: "ops.dead_letter.bulk", tags: { provider: row.provider } });
    }
  }
  for (const row of emailRows) {
    try {
      if (action === "retry") await requeueEmailRow(row);
      else await discardEmailRow(row.id, reason!, adminId);
      succeeded++;
    } catch (err) {
      failed++;
      captureException(err, { level: "warn", route: "ops.dead_letter.bulk", tags: { source: "email" } });
    }
  }

  const processed = succeeded + failed;

  // Recount what's still active after this tick so the client knows whether to
  // run another bounded batch.
  let remaining = 0;
  if (sourceFilter !== "email") {
    let q = supabaseAdmin
      .from("webhook_dead_letters")
      .select("id", { count: "exact", head: true })
      .eq("status", WEBHOOK_ACTIVE_STATUS);
    if (providerFilter) q = q.eq("provider", providerFilter);
    if (ids) q = q.in("id", ids);
    const { count } = await q;
    remaining += count ?? 0;
  }
  if (sourceFilter !== "webhook") {
    let q = supabaseAdmin
      .from("email_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("status", EMAIL_ACTIVE_STATUS);
    if (providerFilter) q = q.eq("category", providerFilter);
    if (ids) q = q.in("id", ids);
    const { count } = await q;
    remaining += count ?? 0;
  }

  await writeAuditLog(
    c,
    bulkAudit(
      action,
      { source: sourceFilter, provider: providerFilter, ids: ids ?? undefined },
      { processed, succeeded, failed },
      reason ?? undefined,
    ),
  );

  return c.json({ ok: true, action, processed, succeeded, failed, remaining });
});

// ── Maintenance mode + scheduled maintenance windows (US-887) ─────
//
// GET    /maintenance      — every window, newest first (any admin).
// POST   /maintenance      — create a window (super_admin + MFA step-up; audited).
// PATCH  /maintenance/:id  — edit / activate / "end now" (super_admin + step-up).
// DELETE /maintenance/:id  — remove a window (super_admin + step-up; audited).
//
// A window puts a scope (platform|grading|flipdesk|checkout) into a mode
// (banner|read_only|blocked), immediately or on a schedule. The edge guard
// (middleware/maintenance.ts) enforces it; the public /api/maintenance/active
// endpoint + the SPA banner surface it. Every mutation busts the short-TTL cache
// so it lands on the next request, and admins always bypass enforcement (AC#6).

// Trim a message to a sane bound; returns null when empty.
function normalizeMaintenanceMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, 1000);
}

// Parse an optional ISO timestamp. Empty/null → null (open bound).
function parseMaintenanceTs(
  v: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    return { ok: false, error: "starts_at / ends_at must be ISO timestamps." };
  }
  return { ok: true, value: new Date(v).toISOString() };
}

function maintenanceWindowAudit(action: string, id: string, after?: unknown, before?: unknown) {
  return {
    action,
    targetType: "maintenance_window",
    targetId: id,
    before,
    after,
  };
}

// GET /maintenance — list all windows (admin read).
adminOpsRoutes.get("/maintenance", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("maintenance_windows")
    .select(MAINTENANCE_SELECT)
    .order("created_at", { ascending: false });
  if (error) {
    captureException(error, { tags: { area: "admin-maintenance" } });
    return c.json({ error: "Failed to load maintenance windows" }, 500);
  }
  return c.json({
    windows: (data ?? []) as MaintenanceWindow[],
    server_now: new Date().toISOString(),
  });
});

// POST /maintenance — create a window. super_admin + fresh MFA step-up.
adminOpsRoutes.post("/maintenance", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  if (!isMaintenanceScope(body.scope)) {
    return c.json({ error: "scope must be platform | grading | flipdesk | checkout" }, 400);
  }
  if (!isMaintenanceMode(body.mode)) {
    return c.json({ error: "mode must be banner | read_only | blocked" }, 400);
  }
  const message = normalizeMaintenanceMessage(body.message);
  if (!message) return c.json({ error: "A message is required." }, 400);

  const starts = parseMaintenanceTs(body.starts_at);
  if (!starts.ok) return c.json({ error: starts.error }, 400);
  const ends = parseMaintenanceTs(body.ends_at);
  if (!ends.ok) return c.json({ error: ends.error }, 400);
  if (starts.value && ends.value && Date.parse(ends.value) <= Date.parse(starts.value)) {
    return c.json({ error: "ends_at must be after starts_at." }, 400);
  }

  const scope = body.scope as MaintenanceScope;
  const mode = body.mode as MaintenanceMode;
  const isActive = typeof body.is_active === "boolean" ? body.is_active : true;

  const { data, error } = await supabaseAdmin
    .from("maintenance_windows")
    .insert({
      scope,
      mode,
      message,
      starts_at: starts.value,
      ends_at: ends.value,
      is_active: isActive,
      created_by: c.get("userId"),
    })
    .select(MAINTENANCE_SELECT)
    .maybeSingle();
  if (error || !data) {
    captureException(error ?? new Error("insert returned no row"), {
      tags: { area: "admin-maintenance" },
    });
    return c.json({ error: "Failed to create maintenance window" }, 500);
  }

  bustMaintenanceCache();
  const row = data as MaintenanceWindow;
  await writeAuditLog(c, maintenanceWindowAudit("maintenance_window.create", row.id, row));

  return c.json({ ok: true, window: row });
});

// PATCH /maintenance/:id — edit / activate / "end now". super_admin + step-up.
adminOpsRoutes.patch("/maintenance/:id", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const id = c.req.param("id");
  const { data: existing, error: loadErr } = await supabaseAdmin
    .from("maintenance_windows")
    .select(MAINTENANCE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    captureException(loadErr, { tags: { area: "admin-maintenance" } });
    return c.json({ error: "Failed to load maintenance window" }, 500);
  }
  if (!existing) return c.json({ error: "Maintenance window not found" }, 404);
  const before = existing as MaintenanceWindow;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if ("scope" in body) {
    if (!isMaintenanceScope(body.scope)) {
      return c.json({ error: "scope must be platform | grading | flipdesk | checkout" }, 400);
    }
    patch.scope = body.scope;
  }
  if ("mode" in body) {
    if (!isMaintenanceMode(body.mode)) {
      return c.json({ error: "mode must be banner | read_only | blocked" }, 400);
    }
    patch.mode = body.mode;
  }
  if ("message" in body) {
    const message = normalizeMaintenanceMessage(body.message);
    if (!message) return c.json({ error: "A message is required." }, 400);
    patch.message = message;
  }
  if ("starts_at" in body) {
    const starts = parseMaintenanceTs(body.starts_at);
    if (!starts.ok) return c.json({ error: starts.error }, 400);
    patch.starts_at = starts.value;
  }
  if ("ends_at" in body) {
    const ends = parseMaintenanceTs(body.ends_at);
    if (!ends.ok) return c.json({ error: ends.error }, 400);
    patch.ends_at = ends.value;
  }
  if ("is_active" in body) {
    if (typeof body.is_active !== "boolean") {
      return c.json({ error: "is_active must be a boolean." }, 400);
    }
    patch.is_active = body.is_active;
  }

  // Validate the resulting schedule ordering against the merged state.
  const nextStarts = (patch.starts_at as string | null | undefined) ?? before.starts_at;
  const nextEnds = (patch.ends_at as string | null | undefined) ?? before.ends_at;
  if (nextStarts && nextEnds && Date.parse(nextEnds) <= Date.parse(nextStarts)) {
    return c.json({ error: "ends_at must be after starts_at." }, 400);
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No updatable fields supplied." }, 400);
  }

  const { data: updated, error: updErr } = await supabaseAdmin
    .from("maintenance_windows")
    .update(patch)
    .eq("id", id)
    .select(MAINTENANCE_SELECT)
    .maybeSingle();
  if (updErr || !updated) {
    captureException(updErr ?? new Error("update returned no row"), {
      tags: { area: "admin-maintenance" },
    });
    return c.json({ error: "Failed to update maintenance window" }, 500);
  }

  bustMaintenanceCache();
  const after = updated as MaintenanceWindow;
  // "End now" (is_active flipped false) is the most common patch — record it
  // distinctly so the audit trail reads clearly.
  const action = before.is_active && after.is_active === false
    ? "maintenance_window.end"
    : "maintenance_window.update";
  await writeAuditLog(c, maintenanceWindowAudit(action, id, after, before));

  return c.json({ ok: true, window: after });
});

// DELETE /maintenance/:id — remove a window. super_admin + step-up.
adminOpsRoutes.delete("/maintenance/:id", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("maintenance_windows")
    .delete()
    .eq("id", id)
    .select(MAINTENANCE_SELECT)
    .maybeSingle();
  if (error) {
    captureException(error, { tags: { area: "admin-maintenance" } });
    return c.json({ error: "Failed to delete maintenance window" }, 500);
  }
  if (!data) return c.json({ error: "Maintenance window not found" }, 404);

  bustMaintenanceCache();
  const row = data as MaintenanceWindow;
  await writeAuditLog(c, maintenanceWindowAudit("maintenance_window.delete", id, undefined, row));

  return c.json({ ok: true, id });
});
