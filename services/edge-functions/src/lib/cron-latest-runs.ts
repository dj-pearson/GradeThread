// US-2318: resolving the LAST RECORDED RUN per cron job, testably.
//
// This was inline in `GET /admin-jobs/crons`, reading `supabaseAdmin` directly,
// which is why AC3's test could not be written — there was no seam to hand a
// synthetic ledger to. The logic is worth testing on its own: it is the only
// thing standing between an operator and a dashboard that says a daily job has
// never run.
//
// THE DEFECT IT ENCODES THE FIX FOR. The route pulled a fixed 2,000-row window
// of `cron_runs` and reduced to latest-per-job in memory. At the current fleet
// cadence (67 recorded jobs, ~141 rows/hour, seven of them on `*/5`) that is
// roughly 14 hours of history, so every daily and 6-hourly job routinely fell
// outside it and rendered as `last_run_at: null` — indistinguishable from a job
// that was never configured. The jobs it hid are the ones that matter most:
// trial-expiry, data-retention, guarantee-pool, billing-reconciliation.
//
// WHY A BIGGER LIMIT IS NOT THE FIX, and the reason this takes a `fetchOne`
// seam rather than a number: the window is a function of FLEET CADENCE. Raising
// 2,000 to 20,000 works today and silently rots the next time someone adds a
// `*/5` job. Asking per job name does not depend on how busy the fleet is, so
// the answer for `trial-expiry` stops changing when an unrelated job is added.

/** The fields the dashboard renders for a job's last run. */
export interface LatestRun {
  status: string;
  http_status: number | null;
  duration_ms: number | null;
  created_at: string;
}

/** A `cron_runs` row as the window query selects it. */
export interface CronRunRow extends LatestRun {
  job_name: string;
}

/**
 * Reduce a newest-first window to latest-per-job, then back-fill the jobs the
 * window missed by asking for each one directly.
 *
 * `windowRows` MUST be ordered newest-first — the reduce keeps the first row it
 * sees per job and ignores the rest, so a wrongly-ordered window silently
 * reports the OLDEST run as the latest. That is not defensively re-sorted here
 * on purpose: re-sorting would hide a caller that dropped its `.order()`, and a
 * dashboard confidently showing a stale timestamp is the failure this module
 * exists to remove.
 *
 * `fetchOne` returns the single most recent row for one job, or null when the
 * job has genuinely never recorded a run. A job still absent afterwards is left
 * OUT of the map rather than given a placeholder, so the caller can keep
 * "never configured" distinguishable from "ran, but a while ago" (AC2).
 */
export async function resolveLatestRuns(
  windowRows: readonly CronRunRow[],
  expectedJobNames: readonly string[],
  fetchOne: (jobName: string) => Promise<CronRunRow | null>,
): Promise<Map<string, LatestRun>> {
  const latest = new Map<string, LatestRun>();
  for (const r of windowRows) {
    if (!latest.has(r.job_name)) {
      latest.set(r.job_name, {
        status: r.status,
        http_status: r.http_status,
        duration_ms: r.duration_ms,
        created_at: r.created_at,
      });
    }
  }

  // Only the misses, and only one row each. `cron_runs` is indexed on
  // (job_name, created_at DESC), so each is a single indexed lookup, and on a
  // healthy fleet this loop is empty. Sequential rather than parallel: this is
  // an admin dashboard read, and a burst of tiny queries at the pooler is a
  // worse trade than a few hundred milliseconds nobody notices.
  for (const name of expectedJobNames) {
    if (latest.has(name)) continue;
    const one = await fetchOne(name);
    if (!one) continue;
    latest.set(name, {
      status: one.status,
      http_status: one.http_status,
      duration_ms: one.duration_ms,
      created_at: one.created_at,
    });
  }
  return latest;
}
