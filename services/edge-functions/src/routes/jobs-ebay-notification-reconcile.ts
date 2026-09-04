// Cron: eBay Notification API subscription reconcile (US-1964).
//
// The app-level Notification API config (destinations + topic subscriptions) is
// the thing every inbound sale/payout/return depends on, and it can drift
// without anyone touching our code: eBay disables a destination after repeated
// delivery failures, an operator edits the dev portal, a new environment is
// stood up with nothing subscribed, or eBay adds a topic our router now
// classifies into a required bucket. This tick re-asserts the desired config and
// — AC4 — logs a warning whenever a required topic is left unsubscribed.
//
// Reuses reconcileNotifications (lib/ebay-notification-subscriptions.ts), which
// is find-or-create on a stable env-scoped destination name + one subscription
// per topic, so a healthy config performs ZERO writes and repeated ticks can
// never duplicate a destination or subscription.
//
// Cheap and app-wide (not per-seller), so it runs infrequently — this is a
// drift detector, not a hot path.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isEbayConfigured } from "../lib/ebay-client.ts";
import { captureException, logEvent, recordMetric } from "../lib/observability.ts";
import {
  reconcileNotifications,
  warnOnMissingTopics,
} from "../lib/ebay-notification-subscriptions.ts";

const JOB_LOCK_LEASE_SECONDS = 300;

// Matches the marketplace-event sweep's bounds, for the same reason: enough
// lines to diagnose, few enough that a total misconfiguration cannot flood the
// log every six hours.
const MAX_LOGGED_ERRORS = 8;
const MAX_ERROR_CHARS = 300;

export async function handleEbayNotificationReconcileCron(
  c: Context,
): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ ok: true, skipped: true, reason: "ebay_not_configured" });
  }
  const verificationToken = Deno.env.get("EBAY_VERIFICATION_TOKEN")?.trim();
  if (!verificationToken) {
    // Without the token eBay can't validate our endpoints, so a reconcile would
    // fail every tick. Warn (this IS a misconfiguration that silently breaks
    // inbound sync) but report a clean skip rather than a red job.
    console.warn(
      "[ebay-notify] EBAY_VERIFICATION_TOKEN is not set; skipping notification reconcile",
    );
    return c.json({ ok: true, skipped: true, reason: "no_verification_token" });
  }

  const lock = await acquireJobLock(
    "ebay-notification-reconcile",
    JOB_LOCK_LEASE_SECONDS,
  );
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const result = await reconcileNotifications({ verificationToken });
    warnOnMissingTopics(result.health, "scheduled reconcile");

    // US-3112: NAME the per-topic failures.
    //
    // reconcileNotifications does not throw on a subscription it could not
    // create or re-point; it collects each one into result.errors and returns
    // 200. The cron ledger then records only a COUNT, because readJobOutcome
    // sums numbers and has nowhere to put a sentence — which is how the 18:17
    // run on 2026-09-03 came to say `{"failures":{"errors":12}}` and nothing
    // else. Twelve of what, for which topic, is the entire question.
    //
    // Bounded and truncated for the same reason the marketplace-event sweep
    // bounds its own: a wholesale misconfiguration would otherwise emit one
    // eBay error body per topic every six hours, and the first few say what the
    // last few say.
    if (result.errors.length > 0) {
      logEvent("warn", "ebay_notification.reconcile_failed", {
        env: result.env,
        count: result.errors.length,
        errors: result.errors.slice(0, MAX_LOGGED_ERRORS).map((e) => ({
          topicId: e.topicId,
          message: e.message.length > MAX_ERROR_CHARS
            ? `${e.message.slice(0, MAX_ERROR_CHARS)}...`
            : e.message,
        })),
      });
    }
    // Meter the drift so "how often does eBay's config fall out from under us"
    // is answerable from a dashboard, not by grepping logs.
    recordMetric("ebay.notification_missing_buckets", result.health.missingBuckets.length, {
      env: result.env,
    });
    return c.json({
      ok: true,
      env: result.env,
      created: result.created,
      enabled: result.enabled,
      repointed: result.repointed,
      alreadyCurrent: result.alreadyCurrent,
      skipped: result.skipped,
      errors: result.errors,
      missingBuckets: result.health.missingBuckets,
      healthy: result.health.ok,
    });
  } catch (err) {
    captureException(err, { route: "jobs-ebay-notification-reconcile.cron" });
    // US-3110: say what actually broke. This job has failed on every run since
    // 2026-08-20 — 128 errors, zero successes — and left no trace anywhere an
    // operator looks: cron_runs.detail only carries numeric failure counts, so
    // it recorded `{}`, and captureException writes to Sentry alone. A restart
    // then rotated away whatever the container log held. One console.error is
    // the difference between "the reconcile is red" and a fixable defect.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ebay-notify] reconcile failed: ${message}`);
    return c.json(
      { error: "eBay notification reconcile failed", message: message.slice(0, 500) },
      500,
    );
  } finally {
    await lock.release();
  }
}
