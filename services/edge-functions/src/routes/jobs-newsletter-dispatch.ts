// US-926: scheduled weekly newsletter dispatch.
//
// ONE scheduled trigger (hourly) assigns send windows to approved issues and
// releases each due issue through the gated sender — applying the per-period
// cadence guard and, when enabled, per-recipient send-time optimization. Running
// hourly (rather than once a week) lets STO stagger recipients across the window
// and lets the cadence guard converge across re-runs; the weekly *cadence* itself
// is config-driven (newsletter_schedule_* settings), so moving the send day needs
// no code change.
//
// Mounted in main.ts as POST /api/jobs/newsletter-dispatch, OUTSIDE the /api/* JWT
// groups, gated by the internal job secret. The /api/jobs/* middleware records the
// run to cron_runs automatically (US-881 jobs console visibility).

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { getSetting } from "../lib/system-settings.ts";
import { runNewsletterDispatch } from "../lib/newsletter-dispatch-job.ts";

const LOCK_LEASE_SECONDS = 300;

export async function handleNewsletterDispatchCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // The program kill-switch halts dispatch. Fail-open so a fresh deploy runs.
  if (!(await isFeatureEnabled("newsletter"))) {
    return c.json({ ok: true, skipped: true, reason: "newsletter halted" });
  }
  // The send pause brake (also flipped by the deliverability guard).
  if (await getSetting<boolean>("newsletter_send_paused", false)) {
    return c.json({ ok: true, skipped: true, reason: "sending paused" });
  }

  const lock = await acquireJobLock("newsletter-dispatch", LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const result = await runNewsletterDispatch(Date.now());
    if (result.skipped) {
      return c.json({ ok: true, skipped: true, reason: result.reason });
    }
    return c.json({
      ok: true,
      scheduledWindows: result.scheduledWindows,
      released: result.released,
      rowsProcessed: result.rowsProcessed,
      issues: result.issues,
    });
  } catch (err) {
    console.error(
      "[newsletter-dispatch] pass failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Dispatch pass failed" }, 500);
  } finally {
    await lock.release();
  }
}
