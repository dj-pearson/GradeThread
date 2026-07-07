// US-1698: scheduled Google Ads sync.
//
// Refreshes our local Ads snapshots (structure + last-30-days daily metrics) on
// a daily schedule so the Command Center dashboard + Claude analysis read fresh
// rows without the operator clicking "sync". Mounted in main.ts as POST
// /api/jobs/ads-sync, OUTSIDE the /api/* JWT groups; the handler enforces
// X-Internal-Job-Secret itself (same pattern as every other Coolify cron).
//
// Suggested Coolify cron: daily, e.g. `0 8 * * *`. Cleanly no-ops (records a
// 'skipped' run) when Google Ads env isn't configured yet.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { performGoogleAdsSync } from "../lib/google-ads-sync-job.ts";

export async function handleAdsSyncCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("ads-sync", 900);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const result = await performGoogleAdsSync({ ownerUserId: null, days: 30 });
    if (!result.configured) {
      // Unconfigured is a clean skip, not a failure (keeps the cron ledger green).
      return c.json({ ok: true, skipped: true, reason: result.message });
    }
    const { httpStatus, ...payload } = result;
    return c.json(payload, httpStatus as 200 | 500 | 502);
  } finally {
    await lock.release();
  }
}
