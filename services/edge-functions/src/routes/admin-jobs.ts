import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { type CronRunRow, resolveLatestRuns } from "../lib/cron-latest-runs.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";
import {
  defaultRegradeStore,
  regradeSubmission,
  reverseChargeForUngradedSubmission,
} from "../lib/grading-pipeline.ts";
import {
  adminCancelGenerationBatch,
  adminCancelPublishBatch,
  adminRetryGenerationBatch,
  adminRetryPublishBatch,
} from "./flipdesk-autolister.ts";
import { CRON_REGISTRY, nextCronRun } from "../lib/cron-runs.ts";
import { callerHasScope, requireScope } from "../lib/scope-guard.ts";
import { requireFreshStepUp } from "../lib/step-up.ts";

// Admin job/queue monitoring + control (US-584).
//
// Mounted at /api/admin/jobs — inherits authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts.
//
// Gives operators a per-job view across every durable job-bearing table
// (grading, eBay sync, AutoLister generation, bulk publish, the email outbox,
// repricing suggestions), manual retry/cancel for a stuck/failed job (audited),
// a dead-letter/backlog drill-down, and cron last-run/next-run health. All
// queries go through the service-role client and are admin-only by mount.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminJobsRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminJobsRoutes.use("*", requireScope("ops:write"));

const KINDS = ["grading", "sync", "autolister", "publish", "email", "repricing"] as const;
type Kind = (typeof KINDS)[number];

interface JobRow {
  kind: Kind;
  id: string;
  label: string;
  status: string;
  user_id: string | null;
  created_at: string;
  updated_at: string | null;
  last_error: string | null;
  attempts: number | null;
  sort_ts: string;
  can_retry: boolean;
  can_cancel: boolean;
}

function clampLimit(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
}

// ── Per-kind loaders ─────────────────────────────────────────────────

async function loadGrading(limit: number, status?: string): Promise<JobRow[]> {
  let q = supabaseAdmin
    .from("submissions")
    .select("id, user_id, title, status, grading_attempts, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  q = status ? q.eq("status", status) : q.in("status", ["pending", "processing", "failed"]);
  const { data } = await q;
  return ((data ?? []) as Array<{
    id: string;
    user_id: string;
    title: string | null;
    status: string;
    grading_attempts: number | null;
    created_at: string;
    updated_at: string | null;
  }>).map((r) => ({
    kind: "grading" as const,
    id: r.id,
    label: r.title ?? "Grade submission",
    status: r.status,
    user_id: r.user_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_error: null,
    attempts: r.grading_attempts,
    sort_ts: r.updated_at ?? r.created_at,
    can_retry: r.status === "failed" || r.status === "processing",
    can_cancel: ["pending", "processing", "failed"].includes(r.status),
  }));
}

async function loadSync(limit: number, status?: string): Promise<JobRow[]> {
  let q = supabaseAdmin
    .from("flipdesk_sync_runs")
    .select("id, user_id, marketplace, status, error_count, errors, started_at, finished_at")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  const { data } = await q;
  return ((data ?? []) as Array<{
    id: string;
    user_id: string;
    marketplace: string;
    status: string;
    error_count: number;
    errors: unknown;
    started_at: string;
    finished_at: string | null;
  }>).map((r) => {
    const errs = Array.isArray(r.errors) ? (r.errors as unknown[]) : [];
    return {
      kind: "sync" as const,
      id: r.id,
      label: `${r.marketplace} sync`,
      status: r.status,
      user_id: r.user_id,
      created_at: r.started_at,
      updated_at: r.finished_at,
      last_error: errs.length > 0 ? String(errs[0]).slice(0, 500) : null,
      attempts: null,
      sort_ts: r.finished_at ?? r.started_at,
      can_retry: false,
      can_cancel: r.status === "running",
    };
  });
}

async function loadBatchKind(
  table: "listing_generation_batches" | "listing_publish_batches",
  kind: "autolister" | "publish",
  limit: number,
  status?: string,
): Promise<JobRow[]> {
  let q = supabaseAdmin
    .from(table)
    .select("id, user_id, status, item_count, succeeded_count, failed_count, error, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  const { data } = await q;
  return ((data ?? []) as Array<{
    id: string;
    user_id: string;
    status: string;
    item_count: number;
    succeeded_count: number;
    failed_count: number;
    error: string | null;
    created_at: string;
    updated_at: string | null;
  }>).map((r) => ({
    kind,
    id: r.id,
    label: `${kind === "autolister" ? "Generate" : "Publish"} ${r.succeeded_count}/${r.item_count}`,
    status: r.status,
    user_id: r.user_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_error: r.error,
    attempts: null,
    sort_ts: r.updated_at ?? r.created_at,
    can_retry: ["failed", "partial", "running"].includes(r.status) && r.failed_count + (r.item_count - r.succeeded_count) > 0,
    can_cancel: ["pending", "running"].includes(r.status),
  }));
}

async function loadEmail(limit: number, status?: string): Promise<JobRow[]> {
  let q = supabaseAdmin
    .from("email_deliveries")
    .select("id, recipient, category, subject, status, attempts, max_attempts, last_error, next_attempt_at, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  q = status ? q.eq("status", status) : q.in("status", ["pending", "dead_letter"]);
  const { data } = await q;
  return ((data ?? []) as Array<{
    id: string;
    recipient: string;
    category: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
    updated_at: string | null;
  }>).map((r) => ({
    kind: "email" as const,
    id: r.id,
    label: `${r.category} → ${r.recipient}`,
    status: r.status,
    user_id: null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_error: r.last_error,
    attempts: r.attempts,
    sort_ts: r.updated_at ?? r.created_at,
    can_retry: ["pending", "dead_letter"].includes(r.status),
    can_cancel: r.status === "pending",
  }));
}

async function loadRepricing(limit: number, status?: string): Promise<JobRow[]> {
  let q = supabaseAdmin
    .from("repricing_suggestions")
    .select("id, user_id, status, reason_code, message, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  q = status ? q.eq("status", status) : q.eq("status", "pending");
  const { data } = await q;
  return ((data ?? []) as Array<{
    id: string;
    user_id: string;
    status: string;
    reason_code: string;
    message: string;
    created_at: string;
    updated_at: string | null;
  }>).map((r) => ({
    kind: "repricing" as const,
    id: r.id,
    label: r.reason_code,
    status: r.status,
    user_id: r.user_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_error: null,
    attempts: null,
    sort_ts: r.updated_at ?? r.created_at,
    can_retry: false,
    can_cancel: false,
  }));
}

function loadKind(kind: Kind, limit: number, status?: string): Promise<JobRow[]> {
  switch (kind) {
    case "grading":
      return loadGrading(limit, status);
    case "sync":
      return loadSync(limit, status);
    case "autolister":
      return loadBatchKind("listing_generation_batches", "autolister", limit, status);
    case "publish":
      return loadBatchKind("listing_publish_batches", "publish", limit, status);
    case "email":
      return loadEmail(limit, status);
    case "repricing":
      return loadRepricing(limit, status);
  }
}

// GET / — per-job view. ?kind=<one> restricts to a single table (returns up to
// `limit` rows); otherwise each kind contributes a slice merged newest-first.
adminJobsRoutes.get("/", async (c) => {
  const kindParam = c.req.query("kind") as Kind | undefined;
  const status = c.req.query("status")?.trim() || undefined;

  if (kindParam) {
    if (!KINDS.includes(kindParam)) return c.json({ error: "Unknown kind" }, 400);
    const limit = clampLimit(c.req.query("limit"), 50, 200);
    const jobs = await loadKind(kindParam, limit, status);
    return c.json({ jobs });
  }

  const perKind = clampLimit(c.req.query("limit"), 25, 100);
  const all = await Promise.all(KINDS.map((k) => loadKind(k, perKind, status)));
  const jobs = all.flat().sort((a, b) => (a.sort_ts < b.sort_ts ? 1 : -1));
  return c.json({ jobs });
});

// GET /dead-letters — backlog drill-down: webhook dead-letters (unresolved),
// dead-lettered emails, and failed AutoLister/publish batches.
adminJobsRoutes.get("/dead-letters", async (c) => {
  const [webhooks, emails, gen, pub] = await Promise.all([
    supabaseAdmin
      .from("webhook_dead_letters")
      .select("id, provider, event_id, event_type, error_message, status, created_at")
      .eq("status", "unresolved")
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("email_deliveries")
      .select("id, recipient, category, subject, attempts, max_attempts, last_error, updated_at")
      .eq("status", "dead_letter")
      .order("updated_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("listing_generation_batches")
      .select("id, user_id, status, item_count, failed_count, error, updated_at")
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(50),
    supabaseAdmin
      .from("listing_publish_batches")
      .select("id, user_id, status, item_count, failed_count, error, updated_at")
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(50),
  ]);
  return c.json({
    webhooks: webhooks.data ?? [],
    emails: emails.data ?? [],
    failed_generation_batches: gen.data ?? [],
    failed_publish_batches: pub.data ?? [],
  });
});

// GET /crons — cron health: schedule, computed next-run, and the most recent
// recorded run (last-run time + outcome) per job.
adminJobsRoutes.get("/crons", async (c) => {
  const now = new Date();
  // Latest recorded run per job. cron_runs is small + indexed by
  // (job_name, created_at DESC); pull a recent window and reduce in memory.
  const { data: runs } = await supabaseAdmin
    .from("cron_runs")
    .select("job_name, status, http_status, duration_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  // US-2318: the reduce + back-fill lives in lib/cron-latest-runs.ts so it can
  // be tested against a synthetic ledger (AC3). It used to be inline here,
  // reading supabaseAdmin directly, which is exactly why the test could not be
  // written — there was no seam to hand a fixture to.
  const latest = await resolveLatestRuns(
    (runs ?? []) as CronRunRow[],
    CRON_REGISTRY.filter((d) => d.recorded !== false).map((d) => d.name),
    async (jobName) => {
      const { data } = await supabaseAdmin
        .from("cron_runs")
        .select("job_name, status, http_status, duration_ms, created_at")
        .eq("job_name", jobName)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data as CronRunRow | null) ?? null;
    },
  );
  const crons = CRON_REGISTRY.map((def) => {
    const last = latest.get(def.name) ?? null;
    return {
      name: def.name,
      label: def.label,
      schedule: def.schedule,
      category: def.category,
      endpoint: def.endpoint,
      recorded: def.recorded,
      next_run_at: nextCronRun(def.schedule, now),
      last_run_at: last?.created_at ?? null,
      last_status: last?.status ?? null,
      last_http_status: last?.http_status ?? null,
      last_duration_ms: last?.duration_ms ?? null,
    };
  });
  return c.json({ crons, server_now: now.toISOString() });
});

// ── Retry / cancel ───────────────────────────────────────────────────

async function readAction(c: Context): Promise<{ kind: Kind; id: string; reason: string } | null> {
  let body: { kind?: string; id?: string; reason?: string };
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  const kind = body.kind as Kind;
  const id = (body.id ?? "").trim();
  if (!KINDS.includes(kind) || !id) return null;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  return { kind, id, reason };
}

// POST /retry — re-run a stuck/failed job. Audited.
adminJobsRoutes.post("/retry", async (c) => {
  // US-2353 AC2 + AC4: retrying a GRADING job voids the issued grade and
  // re-runs it. Two problems, and the second is the one a scope map cannot
  // survive: there was no step-up, and this router's scope is ops:write — so an
  // admin who has never held grading:review could void grades through it. The
  // grading check is applied only to the grading kind, because the other kinds
  // are ordinary ops work and requiring a grading scope for them would be the
  // same category error in reverse.
  const action = await readAction(c);
  if (!action) return c.json({ error: "kind and id are required" }, 400);
  const { kind, id } = action;
  if (kind === "grading") {
    const hasGrading = await callerHasScope(
      c.get("adminRole"),
      c.get("userId") ?? null,
      "grading:review",
    );
    if (!hasGrading) {
      return c.json({
        error:
          "Retrying a grading job voids the issued grade and requires the grading:review permission.",
        code: "SCOPE_REQUIRED",
        scope: "grading:review",
      }, 403);
    }
    const stepUp = requireFreshStepUp(c);
    if (stepUp) return stepUp;
  }

  let result: { ok: boolean; error?: string; detail?: Record<string, unknown> };
  switch (kind) {
    case "grading": {
      const r = await regradeSubmission(id, defaultRegradeStore);
      result = r.ok
        ? { ok: true, detail: { superseded: r.supersededReportIds.length } }
        : { ok: false, error: r.error };
      break;
    }
    case "email": {
      try {
        await updateByIdChecked(
          supabaseAdmin as unknown as CheckedUpdateClient,
          "email_deliveries",
          id,
          { status: "pending", next_attempt_at: new Date().toISOString() },
        );
        result = { ok: true };
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof ZeroRowsAffectedError ? "Email not found" : "Retry failed",
        };
      }
      break;
    }
    case "autolister":
      result = await adminRetryGenerationBatch(id);
      break;
    case "publish":
      result = await adminRetryPublishBatch(id);
      break;
    default:
      return c.json({ error: `Retry is not supported for ${kind} jobs` }, 422);
  }

  if (!result.ok) return c.json({ error: result.error ?? "Retry failed" }, 422);
  await writeAuditLog(c, {
    action: "jobs.retry",
    targetType: kind,
    targetId: id,
    details: { ...(result.detail ?? {}) },
  });
  return c.json({ ok: true, ...(result.detail ?? {}) });
});

// POST /cancel — fail/stop a stuck job so it stops occupying the queue. Audited.
adminJobsRoutes.post("/cancel", async (c) => {
  const action = await readAction(c);
  if (!action) return c.json({ error: "kind and id are required" }, 400);
  const { kind, id, reason } = action;
  const note = reason || "Cancelled by admin";

  let result: { ok: boolean; error?: string; detail?: Record<string, unknown> };
  switch (kind) {
    case "grading": {
      try {
        await updateByIdChecked(
          supabaseAdmin as unknown as CheckedUpdateClient,
          "submissions",
          id,
          { status: "failed", grading_lease_until: null },
        );
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof ZeroRowsAffectedError ? "Submission not found" : "Cancel failed",
        };
        break;
      }
      // Refund the pre-charge for the now-ungraded submission (idempotent).
      await reverseChargeForUngradedSubmission(id, "admin cancelled grade");
      result = { ok: true, detail: { refunded: true } };
      break;
    }
    case "email": {
      try {
        await updateByIdChecked(
          supabaseAdmin as unknown as CheckedUpdateClient,
          "email_deliveries",
          id,
          { status: "dead_letter" },
        );
        result = { ok: true };
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof ZeroRowsAffectedError ? "Email not found" : "Cancel failed",
        };
      }
      break;
    }
    case "sync": {
      const { data } = await supabaseAdmin
        .from("flipdesk_sync_runs")
        .update({ status: "failed", finished_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "running")
        .select("id");
      result = (data && data.length > 0)
        ? { ok: true }
        : { ok: false, error: "Sync run not found or not running" };
      break;
    }
    case "autolister":
      result = await adminCancelGenerationBatch(id, note);
      break;
    case "publish":
      result = await adminCancelPublishBatch(id, note);
      break;
    default:
      return c.json({ error: `Cancel is not supported for ${kind} jobs` }, 422);
  }

  if (!result.ok) return c.json({ error: result.error ?? "Cancel failed" }, 422);
  await writeAuditLog(c, {
    action: "jobs.cancel",
    targetType: kind,
    targetId: id,
    details: { reason: note, ...(result.detail ?? {}) },
  });
  return c.json({ ok: true, ...(result.detail ?? {}) });
});
