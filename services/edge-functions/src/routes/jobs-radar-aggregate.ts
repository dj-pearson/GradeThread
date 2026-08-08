// US-1863: Thrift Radar aggregation cron.
//
// Recomputes every venue x window x brand aggregate from the de-identified scan
// events (00550) and publishes only the groups that clear the k-anonymity floor,
// then retires raw events past the retention window into the month-resolution
// archive (00552).
//
// Job-secret gated + overlap-locked, the standard shape. Run on a Coolify
// scheduled task:
//   curl -fsS -X POST https://functions.gradethread.com/api/jobs/radar-aggregate \
//     -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET"
//
// Idempotent by construction: the whole aggregate set is rebuilt each run and
// anything the run did not rewrite is swept, so a double fire produces the same
// table rather than double counts.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { runRadarAggregation } from "../lib/radar-aggregate-engine.ts";

export async function handleRadarAggregateCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // 900s lease: the prune walks up to max_prune_events_per_run rows in pages,
  // which is the long half of the run.
  const lock = await acquireJobLock("radar-aggregate", 900);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const summary = await runRadarAggregation();
    return c.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      "[jobs-radar-aggregate]:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Radar aggregation failed" }, 500);
  } finally {
    await lock.release();
  }
}
