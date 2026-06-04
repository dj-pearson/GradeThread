// Overlap locks for scheduled jobs (US-503).
//
// Wrap a cron handler's work so a slow run can't race the next scheduled
// invocation and double-apply mutations. Backed by job_locks +
// try_acquire_job_lock / release_job_lock (migration 00094): a lease-based
// claim so a crashed holder's lock auto-expires.
//
// FAIL-SAFE: if the lock RPC errors (DB blip), we treat the job as NOT acquired
// and SKIP this run. Missing one tick is recoverable (the next tick retries);
// double-applying work is not. The lease must comfortably exceed the job's
// expected runtime.
//
// `rpc` is injectable so the acquire/skip/release logic is unit-testable without
// a DB (mirrors the rate-limit / plan-gate injectable-deps pattern).

import { supabaseAdmin } from "./supabase.ts";
import { captureException, logEvent } from "./observability.ts";

export type JobLockRpc = (
  name: "try_acquire_job_lock" | "release_job_lock",
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;

const defaultRpc: JobLockRpc = (name, args) =>
  supabaseAdmin.rpc(name, args) as unknown as ReturnType<JobLockRpc>;

export interface AcquiredLock {
  /** True if the caller now holds the lock. */
  acquired: boolean;
  /** Why it wasn't acquired (when acquired === false). */
  reason?: "locked" | "lock_error";
  /** Release the lock. No-op / best-effort when not acquired. */
  release: () => Promise<void>;
}

// Lower-level acquire/release for route handlers with multiple early returns:
//
//   const lock = await acquireJobLock("publish-due", 240);
//   if (!lock.acquired) return c.json({ skipped: true, reason: lock.reason });
//   try { ...work with early returns... } finally { await lock.release(); }
export async function acquireJobLock(
  jobName: string,
  leaseSeconds: number,
  rpc: JobLockRpc = defaultRpc,
): Promise<AcquiredLock> {
  const noop = () => Promise.resolve();
  let acquired = false;
  try {
    const { data, error } = await rpc("try_acquire_job_lock", {
      p_job: jobName,
      p_lease_seconds: leaseSeconds,
      p_holder: null,
    });
    if (error) {
      captureException(error, { level: "warn", route: "job-lock.acquire", tags: { job: jobName } });
      return { acquired: false, reason: "lock_error", release: noop };
    }
    acquired = data === true;
  } catch (err) {
    captureException(err, { level: "warn", route: "job-lock.acquire", tags: { job: jobName } });
    return { acquired: false, reason: "lock_error", release: noop };
  }

  if (!acquired) {
    logEvent("info", "job.skipped_locked", { job: jobName });
    return { acquired: false, reason: "locked", release: noop };
  }

  return {
    acquired: true,
    release: async () => {
      try {
        const { error } = await rpc("release_job_lock", { p_job: jobName });
        if (error) logEvent("warn", "job.release_failed", { job: jobName });
      } catch {
        logEvent("warn", "job.release_failed", { job: jobName });
      }
    },
  };
}

export interface JobLockResult<T> {
  ran: boolean;
  result?: T;
  skipped?: "locked" | "lock_error";
}

export async function withJobLock<T>(
  jobName: string,
  leaseSeconds: number,
  fn: () => Promise<T>,
  rpc: JobLockRpc = defaultRpc,
): Promise<JobLockResult<T>> {
  const lock = await acquireJobLock(jobName, leaseSeconds, rpc);
  if (!lock.acquired) {
    return { ran: false, skipped: lock.reason };
  }
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    await lock.release();
  }
}
