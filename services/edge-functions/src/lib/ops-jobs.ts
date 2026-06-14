// US-881: Operations console — background-jobs aggregation (pure helpers).
//
// DB-free logic for the /api/admin/ops/jobs surface so the success-rate,
// consecutive-failure (the sidebar alert badge), status mapping and run-now
// audit shape are all unit-testable without a live database (mirrors the
// content-search-signals pure/loader split).
//
// The job-runs ledger IS cron_runs (US-584 / 00164): one row per /api/jobs/*
// invocation recorded by the main.ts middleware. US-881 added triggered_by +
// rows_processed columns (migration 00205) rather than a redundant job_runs
// table — see that migration's header for the reconciliation rationale.

import { CRON_REGISTRY, type CronDef, nextCronRun } from "./cron-runs.ts";

// US-881 status vocabulary. The ledger stores success/error/skipped; "running"
// is derived live from a currently-held job_locks row, never persisted.
export type JobRunStatus = "succeeded" | "failed" | "skipped" | "running";

// Map the stored cron_runs.status to the US-881 enum. Unknown values surface as
// "failed" so an unexpected outcome is visible (red), never silently hidden.
export function mapRunStatus(stored: string): Exclude<JobRunStatus, "running"> {
  switch (stored) {
    case "success":
      return "succeeded";
    case "skipped":
      return "skipped";
    case "error":
      return "failed";
    default:
      return "failed";
  }
}

// A job is manually runnable only when it's served at /api/jobs/<name>
// (recorded === true) — those are reachable by the internal Run-now trigger.
// The eBay/Google crons (recorded === false) live under /api/flipdesk/* and
// need per-user context, so they are observe-only in the console.
export const RUNNABLE_JOB_KEYS: ReadonlySet<string> = new Set(
  CRON_REGISTRY.filter((d) => d.recorded).map((d) => d.name),
);

export function isRunnableJob(key: string): boolean {
  return RUNNABLE_JOB_KEYS.has(key);
}

// Audit action recorded for every manual Run-now (asserted in tests + used by
// the route so the two can't drift).
export const OPS_RUN_AUDIT_ACTION = "ops.job_run";

export function manualRunAudit(
  key: string,
  adminId: string,
  endpoint: string,
): { action: string; targetType: string; targetId: string; details: Record<string, unknown> } {
  return {
    action: OPS_RUN_AUDIT_ACTION,
    targetType: "cron_job",
    targetId: key,
    details: { triggered_by: `admin:${adminId}`, endpoint },
  };
}

// A job with at least this many consecutive recent failures (newest-first) is
// flagged as failing for the sidebar badge.
export const FAILING_THRESHOLD = 2;

export interface RawRun {
  job_name: string;
  status: string;
  http_status: number | null;
  duration_ms: number | null;
  rows_processed: number | null;
  triggered_by: string | null;
  created_at: string;
}

export interface JobSummary {
  name: string;
  label: string;
  schedule: string;
  category: string;
  endpoint: string;
  recorded: boolean;
  runnable: boolean;
  running: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: JobRunStatus | null;
  last_http_status: number | null;
  last_duration_ms: number | null;
  last_rows_processed: number | null;
  last_triggered_by: string | null;
  runs_total: number;
  // succeeded / (succeeded + failed) over the window; null when no terminal runs.
  success_rate: number | null;
  // Leading run of failures (newest-first); drives the failing badge.
  consecutive_failures: number;
}

/**
 * Join the static cron registry with recent run rows to produce a per-job
 * summary: last run, outcome, duration, rows, rolling success rate, leading
 * consecutive-failure count and computed next-due time.
 *
 * `runningJobs` is the set of job names with a currently-held job_locks lease;
 * a match flags the job "running" (best-effort: only accurate when a handler's
 * lock name equals its registry job name).
 */
export function aggregateJobStats(
  runs: RawRun[],
  now: Date,
  opts: { runningJobs?: ReadonlySet<string>; registry?: readonly CronDef[] } = {},
): JobSummary[] {
  const registry = opts.registry ?? CRON_REGISTRY;
  const running = opts.runningJobs ?? new Set<string>();

  const byJob = new Map<string, RawRun[]>();
  for (const r of runs) {
    const arr = byJob.get(r.job_name) ?? [];
    arr.push(r);
    byJob.set(r.job_name, arr);
  }
  // Newest-first per job (defensive — callers pass a created_at DESC window).
  for (const arr of byJob.values()) {
    arr.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  return registry.map((def) => {
    const jruns = byJob.get(def.name) ?? [];
    const last = jruns[0] ?? null;

    let succeeded = 0;
    let failed = 0;
    for (const r of jruns) {
      const s = mapRunStatus(r.status);
      if (s === "succeeded") succeeded++;
      else if (s === "failed") failed++;
    }

    let consecutiveFailures = 0;
    for (const r of jruns) {
      if (mapRunStatus(r.status) === "failed") consecutiveFailures++;
      else break;
    }

    const denom = succeeded + failed;
    return {
      name: def.name,
      label: def.label,
      schedule: def.schedule,
      category: def.category,
      endpoint: def.endpoint,
      recorded: def.recorded,
      runnable: def.recorded,
      running: running.has(def.name),
      next_run_at: nextCronRun(def.schedule, now),
      last_run_at: last?.created_at ?? null,
      last_status: last ? mapRunStatus(last.status) : null,
      last_http_status: last?.http_status ?? null,
      last_duration_ms: last?.duration_ms ?? null,
      last_rows_processed: last?.rows_processed ?? null,
      last_triggered_by: last?.triggered_by ?? null,
      runs_total: jruns.length,
      success_rate: denom > 0 ? succeeded / denom : null,
      consecutive_failures: consecutiveFailures,
    };
  });
}

/** Count of jobs flagged failing (>= FAILING_THRESHOLD consecutive failures). */
export function failingJobCount(summaries: JobSummary[]): number {
  return summaries.filter((s) => s.consecutive_failures >= FAILING_THRESHOLD).length;
}
