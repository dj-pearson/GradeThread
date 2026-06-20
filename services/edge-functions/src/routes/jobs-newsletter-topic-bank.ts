// US-917: scheduled evergreen topic-bank refill.
//
// Tops the email_topic_bank up toward its target when the active-row count drops
// below the configured minimum, generating fresh evergreen, email-appropriate
// angles with the lightweight model (Haiku). Mounted in main.ts as POST
// /api/jobs/newsletter-topic-bank-refill, OUTSIDE the /api/* JWT groups; the
// handler enforces X-Internal-Job-Secret itself (same pattern as the other crons).
// The /api/jobs/* middleware records the run to cron_runs automatically.
//
// Suggested Coolify cron: weekly, e.g. `0 5 * * 1`. Cleanly no-ops (above minimum
// or refill disabled) without spending on AI.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { refillEmailTopicBank } from "../lib/newsletter-topic-bank-job.ts";

const LOCK_LEASE_SECONDS = 300;

export async function handleNewsletterTopicBankRefillCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // The newsletter program kill-switch halts refill too (no point growing a bank
  // for a halted program). Fail-open so a fresh deploy runs.
  if (!(await isFeatureEnabled("newsletter"))) {
    return c.json({ ok: true, skipped: true, reason: "newsletter halted" });
  }

  const lock = await acquireJobLock("newsletter-topic-bank-refill", LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const result = await refillEmailTopicBank();
    return c.json(result);
  } catch (err) {
    console.error(
      "[newsletter-topic-bank] refill failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Topic-bank refill failed" }, 500);
  } finally {
    await lock.release();
  }
}
