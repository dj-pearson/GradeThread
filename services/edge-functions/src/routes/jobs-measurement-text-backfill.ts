// US-3035: cron that drains synced listing text into the Fit & Measurement
// Index.
//
// Mounted in main.ts as POST /api/jobs/measurement-text-backfill, OUTSIDE the
// /api/* JWT groups, gated by the internal job secret and job-locked so
// overlapping runs no-op. Same shape as jobs-passport-backfill.ts.
//
//   curl -fsS -X POST https://functions.gradethread.com/api/jobs/measurement-text-backfill \
//     -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET"
//
// Two maintenance switches, for the two halves of a parser fix. Both are
// operator actions and neither is something a schedule should ever send:
//
//   ?reset=1  clear the scan markers so every item is read again with the new
//             rules. Values the fixed parser still accepts get overwritten.
//   ?purge=1  delete every listing_text observation first. Needed when the OLD
//             rules wrote values the new rules would refuse, because a value
//             the fixed parser declines to parse is one it never overwrites,
//             so a re-scan alone would leave it in place forever.
//
// Passing purge without reset is accepted and does the obvious thing: the rows
// go, and the markers stay, so nothing is re-read. That is only useful to
// retire the source entirely, which is exactly what it should be used for if
// the parser is ever found to be wrong in a way nobody wants to re-run.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  backfillMeasurementsFromText,
  purgeListingTextObservations,
  resetTextScanMarkers,
  TEXT_BACKFILL_BATCH,
} from "../lib/measurement-text-backfill.ts";

export async function handleMeasurementTextBackfillCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("measurement-text-backfill", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const purged = c.req.query("purge") === "1"
      ? await purgeListingTextObservations()
      : 0;
    const unmarked = c.req.query("reset") === "1" ? await resetTextScanMarkers() : 0;

    const batchRaw = Number(c.req.query("limit"));
    const batch = Number.isFinite(batchRaw) && batchRaw > 0
      ? Math.min(Math.floor(batchRaw), 1000)
      : TEXT_BACKFILL_BATCH;

    const summary = await backfillMeasurementsFromText(batch);
    return c.json({ ok: true, purged, unmarked, ...summary });
  } catch (err) {
    console.error(
      "[jobs-measurement-text-backfill]:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Measurement text backfill failed" }, 500);
  } finally {
    await lock.release();
  }
}
