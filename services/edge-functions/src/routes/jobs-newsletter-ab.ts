// US-927: scheduled A/B-test finalizer for the autonomous newsletter.
//
// ONE scheduled trigger sweeps issues whose A/B measurement window has elapsed,
// selects the winning subject from holdout engagement, and sends it to the
// remainder — fully autonomously (no human picks the winner). The winner is still
// visible/overridable in the admin console.
//
// Mounted in main.ts as POST /api/jobs/newsletter-ab-finalize, OUTSIDE the /api/*
// JWT groups, gated by the internal job secret. The /api/jobs/* middleware records
// the run to cron_runs automatically.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { getSetting } from "../lib/system-settings.ts";
import { scanAndFinalizeDueAbTests } from "../lib/newsletter-ab-job.ts";

// US-2311: lease is 2x the */15 schedule interval. At <= 1x, a run that
// overruns by a second is displaced by the very next tick.
const LOCK_LEASE_SECONDS = 1800;

export async function handleNewsletterAbFinalizeCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // The newsletter program kill-switch halts finalization too (no point finishing
  // a send for a halted program). Fail-open so a fresh deploy runs.
  if (!(await isFeatureEnabled("newsletter"))) {
    return c.json({ ok: true, skipped: true, reason: "newsletter halted" });
  }
  if (!(await getSetting<boolean>("newsletter_ab_test_enabled", true))) {
    return c.json({ ok: true, skipped: true, reason: "ab testing disabled" });
  }

  const lock = await acquireJobLock("newsletter-ab-finalize", LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const result = await scanAndFinalizeDueAbTests(Date.now());
    return c.json({ ok: true, scanned: result.scanned, finalized: result.finalized, details: result.details });
  } catch (err) {
    console.error(
      "[newsletter-ab] finalize pass failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "A/B finalize pass failed" }, 500);
  } finally {
    await lock.release();
  }
}
