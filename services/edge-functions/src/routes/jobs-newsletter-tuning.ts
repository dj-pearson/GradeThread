// US-928: scheduled newsletter self-tuning analysis pass.
//
// ONE scheduled trigger (Coolify cron / Make.com) recomputes the topic / subject-
// style / send-hour selection weights from recorded engagement and persists them
// to the settings registry, so the next assembled issue is biased toward what
// engages — fully autonomously, no manual inputs. Guardrails (exploration floor +
// unsub-ceiling pause) live in the pure weighting; this handler just orchestrates
// the DB pass under a lock.
//
// Mounted in main.ts as POST /api/jobs/newsletter-tuning, OUTSIDE the /api/* JWT
// groups, gated by X-Internal-Job-Secret (same pattern as the other crons). The
// /api/jobs/* middleware records the run to cron_runs automatically.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { getSetting } from "../lib/system-settings.ts";
import { recomputeNewsletterTuning } from "../lib/newsletter-tuning-job.ts";

const LOCK_LEASE_SECONDS = 300;

export async function handleNewsletterTuningCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Fleet-wide kill-switch: the newsletter program flag halts tuning too (no point
  // tuning a halted program). Fail-open so a fresh deploy runs.
  if (!(await isFeatureEnabled("newsletter"))) {
    return c.json({ ok: true, skipped: true, reason: "newsletter halted" });
  }
  // Self-tuning can be frozen independently (keep the current weights) without
  // halting the whole program.
  if (!(await getSetting<boolean>("newsletter_tuning_enabled", true))) {
    return c.json({ ok: true, skipped: true, reason: "tuning disabled" });
  }

  const lock = await acquireJobLock("newsletter-tuning", LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const nowMs = Date.now();
    const result = await recomputeNewsletterTuning(nowMs, new Date(nowMs).toISOString(), null);
    const rec = result.recommendations;
    return c.json({
      ok: true,
      topicSent: rec.topicSent,
      topicWinner: rec.topicWinner,
      pausedTopics: rec.pausedTopics,
      subjectWinner: rec.subjectWinner,
      bestSendHour: rec.sendHour.bestHour,
    });
  } catch (err) {
    console.error(
      "[newsletter-tuning] pass failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Tuning pass failed" }, 500);
  } finally {
    await lock.release();
  }
}
