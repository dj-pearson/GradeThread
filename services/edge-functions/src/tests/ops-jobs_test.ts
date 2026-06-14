// US-881: Operations console — background-jobs aggregation + run-now lock tests.

import { assertEquals } from "@std/assert";

// Env BEFORE importing modules that touch the supabase client at import time.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key");

const {
  aggregateJobStats,
  failingJobCount,
  isRunnableJob,
  mapRunStatus,
  manualRunAudit,
  OPS_RUN_AUDIT_ACTION,
  FAILING_THRESHOLD,
} = await import("../lib/ops-jobs.ts");
const { acquireJobLock } = await import("../lib/job-lock.ts");
import type { JobLockRpc } from "../lib/job-lock.ts";
import type { CronDef } from "../lib/cron-runs.ts";
import type { RawRun } from "../lib/ops-jobs.ts";

const NOW = new Date("2026-06-14T12:00:00Z");

const REGISTRY: CronDef[] = [
  { name: "email-retry", label: "Email outbox retry", schedule: "*/5 * * * *", category: "email", endpoint: "/api/jobs/email-retry", recorded: true },
  { name: "ebay-token-refresh", label: "eBay token refresh", schedule: "0 * * * *", category: "sync", endpoint: "/api/flipdesk/ebay/oauth/refresh", recorded: false },
];

function run(job: string, status: string, createdAt: string, extra: Partial<RawRun> = {}): RawRun {
  return {
    job_name: job,
    status,
    http_status: extra.http_status ?? null,
    duration_ms: extra.duration_ms ?? null,
    rows_processed: extra.rows_processed ?? null,
    triggered_by: extra.triggered_by ?? null,
    created_at: createdAt,
  };
}

// ── mapRunStatus ─────────────────────────────────────────────────────
Deno.test("mapRunStatus maps stored vocabulary to the US-881 enum", () => {
  assertEquals(mapRunStatus("success"), "succeeded");
  assertEquals(mapRunStatus("error"), "failed");
  assertEquals(mapRunStatus("skipped"), "skipped");
  // Unknown surfaces as failed (visible, not hidden).
  assertEquals(mapRunStatus("weird"), "failed");
});

// ── isRunnableJob ────────────────────────────────────────────────────
Deno.test("isRunnableJob: only /api/jobs/* (recorded) crons are runnable", () => {
  // From the real registry: a recorded job is runnable, an eBay cron is not.
  assertEquals(isRunnableJob("email-retry"), true);
  assertEquals(isRunnableJob("ebay-token-refresh"), false);
  assertEquals(isRunnableJob("does-not-exist"), false);
});

// ── aggregateJobStats ────────────────────────────────────────────────
Deno.test("aggregateJobStats: success rate + last run + next due", () => {
  const runs: RawRun[] = [
    run("email-retry", "success", "2026-06-14T11:55:00Z", { duration_ms: 120, rows_processed: 3, triggered_by: "schedule" }),
    run("email-retry", "error", "2026-06-14T11:50:00Z"),
    run("email-retry", "success", "2026-06-14T11:45:00Z"),
    run("email-retry", "skipped", "2026-06-14T11:40:00Z"), // skipped excluded from rate
  ];
  const [email] = aggregateJobStats(runs, NOW, { registry: REGISTRY });
  assertEquals(email.name, "email-retry");
  assertEquals(email.runs_total, 4);
  // 2 succeeded / (2 succeeded + 1 failed) = 0.666…
  assertEquals(email.success_rate, 2 / 3);
  // Newest run is the success at 11:55.
  assertEquals(email.last_status, "succeeded");
  assertEquals(email.last_run_at, "2026-06-14T11:55:00Z");
  assertEquals(email.last_rows_processed, 3);
  assertEquals(email.last_triggered_by, "schedule");
  assertEquals(email.runnable, true);
  assertEquals(typeof email.next_run_at, "string");
});

Deno.test("aggregateJobStats: no runs → nulls, not a crash", () => {
  const [email, ebay] = aggregateJobStats([], NOW, { registry: REGISTRY });
  assertEquals(email.runs_total, 0);
  assertEquals(email.success_rate, null);
  assertEquals(email.last_status, null);
  assertEquals(email.consecutive_failures, 0);
  // The eBay cron is observe-only.
  assertEquals(ebay.runnable, false);
  assertEquals(ebay.running, false);
});

Deno.test("aggregateJobStats: consecutive failures counted newest-first only", () => {
  const runs: RawRun[] = [
    run("email-retry", "error", "2026-06-14T11:55:00Z"),
    run("email-retry", "error", "2026-06-14T11:50:00Z"),
    run("email-retry", "success", "2026-06-14T11:45:00Z"), // breaks the streak
    run("email-retry", "error", "2026-06-14T11:40:00Z"),   // earlier failure not counted
  ];
  const [email] = aggregateJobStats(runs, NOW, { registry: REGISTRY });
  assertEquals(email.consecutive_failures, 2);
});

Deno.test("aggregateJobStats: a skipped newest run breaks the failure streak", () => {
  const runs: RawRun[] = [
    run("email-retry", "skipped", "2026-06-14T11:55:00Z"),
    run("email-retry", "error", "2026-06-14T11:50:00Z"),
  ];
  const [email] = aggregateJobStats(runs, NOW, { registry: REGISTRY });
  assertEquals(email.consecutive_failures, 0);
  assertEquals(email.last_status, "skipped");
});

Deno.test("aggregateJobStats: running flag from held locks; tolerates unsorted input", () => {
  const runs: RawRun[] = [
    // Deliberately out of order — aggregate must sort newest-first.
    run("email-retry", "success", "2026-06-14T11:40:00Z"),
    run("email-retry", "error", "2026-06-14T11:55:00Z"),
  ];
  const [email] = aggregateJobStats(runs, NOW, {
    registry: REGISTRY,
    runningJobs: new Set(["email-retry"]),
  });
  assertEquals(email.running, true);
  assertEquals(email.last_status, "failed");
  assertEquals(email.last_run_at, "2026-06-14T11:55:00Z");
});

// ── failingJobCount ──────────────────────────────────────────────────
Deno.test("failingJobCount: flags jobs at/above the threshold", () => {
  const runs: RawRun[] = [];
  for (let i = 0; i < FAILING_THRESHOLD; i++) {
    runs.push(run("email-retry", "error", `2026-06-14T11:${50 - i}:00Z`));
  }
  const summaries = aggregateJobStats(runs, NOW, { registry: REGISTRY });
  assertEquals(failingJobCount(summaries), 1);

  // One success on top clears the streak → not failing.
  const cleared = aggregateJobStats(
    [run("email-retry", "success", "2026-06-14T11:59:00Z"), ...runs],
    NOW,
    { registry: REGISTRY },
  );
  assertEquals(failingJobCount(cleared), 0);
});

// ── manualRunAudit ───────────────────────────────────────────────────
Deno.test("manualRunAudit: stable audit shape for the run-now write", () => {
  const audit = manualRunAudit("email-retry", "admin-uuid", "/api/jobs/email-retry");
  assertEquals(audit.action, OPS_RUN_AUDIT_ACTION);
  assertEquals(audit.action, "ops.job_run");
  assertEquals(audit.targetType, "cron_job");
  assertEquals(audit.targetId, "email-retry");
  assertEquals(audit.details.triggered_by, "admin:admin-uuid");
  assertEquals(audit.details.endpoint, "/api/jobs/email-retry");
});

// ── run-now lock (the gate the route uses) ───────────────────────────
Deno.test("run-now lock: a held lock skips the manual run", async () => {
  // Mirrors the route: acquireJobLock("manual-run:<key>", …). RPC reports the
  // lease is held by a live run → not acquired → the route returns 409 skipped.
  const lockedRpc: JobLockRpc = (name) => {
    if (name === "try_acquire_job_lock") return Promise.resolve({ data: false, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  const lock = await acquireJobLock("manual-run:email-retry", 180, lockedRpc);
  assertEquals(lock.acquired, false);
  assertEquals(lock.reason, "locked");
});

Deno.test("run-now lock: a free lock is acquired and releasable", async () => {
  const released: string[] = [];
  const freeRpc: JobLockRpc = (name, args) => {
    if (name === "try_acquire_job_lock") return Promise.resolve({ data: true, error: null });
    released.push(String((args as { p_job: string }).p_job));
    return Promise.resolve({ data: null, error: null });
  };
  const lock = await acquireJobLock("manual-run:email-retry", 180, freeRpc);
  assertEquals(lock.acquired, true);
  await lock.release();
  assertEquals(released, ["manual-run:email-retry"]);
});
