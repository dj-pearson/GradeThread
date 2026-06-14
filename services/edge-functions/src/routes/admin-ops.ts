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
