// US-1773: cross-garment durability aggregation cron.
//
// Rolls up every garment's condition curve by sku_class into the deny-all
// durability_aggregates table (00406), which backs the public durability
// rankings (US-1774). Idempotent (upsert by sku_class_key), overlap-locked, and
// gated by X-Internal-Job-Secret. Run on a Coolify scheduled task (e.g. daily):
//   curl -fsS -X POST https://functions.gradethread.com/api/jobs/durability-aggregate \
//     -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET"
// Returns { classes, sufficient, upserted }. Cohorts below the sample floor are
// still written (sufficient=false) so the ranking endpoint can filter, mirroring
// the condition-index philosophy — thin cohorts never ship a public claim.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { computeDurabilityAggregates } from "../lib/durability-aggregate.ts";

export async function handleDurabilityAggregateCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("durability-aggregate", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const summary = await computeDurabilityAggregates();
    return c.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      "[jobs-durability-aggregate]:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Durability aggregation failed" }, 500);
  } finally {
    // US-2311: this ran daily with no release, so the lease (600s) was the only
    // thing that ever freed the lock — and an operator hitting Run Now inside
    // that window got a silent no-op that looked like a completed run.
    await lock.release();
  }
}
