// Cron: snapshot eBay's own view of our quota consumption (US-3042).
//
// eBay's Application Growth Check asks what our call volume is. lib/ebay-call-log.ts
// answers that from our side; this tick answers it from eBay's, by reading the
// Developer Analytics getRateLimits endpoint and storing what it says.
//
// Runs hourly rather than daily on purpose. eBay's counters reset on a rolling
// window, so a once-a-day read lands at an arbitrary point in that window and
// tells us nothing about the PEAK — which is the number that matters, because
// hitting the ceiling at 4pm is what forces a publish into tomorrow. Hourly
// samples make the peak visible.
//
// It also flushes the in-process call buffer first, so the two numbers in the
// database are taken at roughly the same moment and are worth subtracting.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isEbayConfigured } from "../lib/ebay-client.ts";
import { flushEbayCallLog } from "../lib/ebay-call-log.ts";
import { snapshotEbayRateLimits } from "../lib/ebay-rate-limits.ts";
import { captureException, recordMetric } from "../lib/observability.ts";

const JOB_LOCK_LEASE_SECONDS = 120;

// Warn above this share of any single resource's limit. 0.8 leaves room to act
// before publishes actually start failing.
const UTILIZATION_WARN = 0.8;

export async function handleEbayRateLimitsCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ ok: true, skipped: true, reason: "ebay_not_configured" });
  }

  const lock = await acquireJobLock("ebay-rate-limits", JOB_LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    // Our side first, so the two counts describe the same moment.
    const flushed = await flushEbayCallLog();

    const { written, tightest } = await snapshotEbayRateLimits();

    if (tightest) {
      recordMetric("ebay.quota_utilization_pct", Math.round(tightest.pct * 100), {
        resource: tightest.resource,
      });
      if (tightest.pct >= UTILIZATION_WARN) {
        // Loud, because the consequence is deferred listings and the fix
        // (asking eBay for more) takes weeks, not minutes.
        console.warn(
          `[ebay-rate-limits] ${tightest.resource} at ${
            Math.round(tightest.pct * 100)
          }% of quota (${tightest.used}/${tightest.limit})`,
        );
      }
    }

    return c.json({
      ok: true,
      bucketsFlushed: flushed,
      resourcesRecorded: written,
      tightest,
    });
  } catch (err) {
    captureException(err, { route: "jobs-ebay-rate-limits.cron" });
    return c.json({ error: "eBay rate-limit snapshot failed" }, 500);
  } finally {
    await lock.release();
  }
}
