// US-3036: nightly rollup of garment_measurements into the numbers a public
// page is allowed to print.
//
// Mounted in main.ts as POST /api/jobs/measurement-aggregate, OUTSIDE the
// /api/* JWT groups, gated by the internal job secret and job-locked so
// overlapping runs no-op. Same shape as jobs-durability-aggregate.ts.
//
//   curl -fsS -X POST https://functions.gradethread.com/api/jobs/measurement-aggregate \
//     -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET"
//
// Returns { cohorts, sufficient, upserted }. `sufficient` is the number the
// US-3037 gate reads: it is the count of cohorts that clear both floors, which
// is the count of numbers that could appear on a page.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { computeMeasurementAggregates } from "../lib/measurement-aggregate.ts";

export async function handleMeasurementAggregateCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("measurement-aggregate", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const summary = await computeMeasurementAggregates();
    return c.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      "[jobs-measurement-aggregate]:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Measurement aggregation failed" }, 500);
  } finally {
    await lock.release();
  }
}
