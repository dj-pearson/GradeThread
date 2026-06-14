import { Hono } from "hono";
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
