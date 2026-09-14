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
import { MAX_DIAGNOSTICS } from "../lib/cron-run-outcome.ts";
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
    const boundedErrors = result.errors.slice(0, MAX_LOGGED_ERRORS).map((e) => ({
      topicId: e.topicId,
      message: e.message.length > MAX_ERROR_CHARS
        ? `${e.message.slice(0, MAX_ERROR_CHARS)}...`
        : e.message,
    }));
    if (result.errors.length > 0) {
      logEvent("warn", "ebay_notification.reconcile_failed", {
        env: result.env,
        count: result.errors.length,
        errors: boundedErrors,
      });
    }

    // US-3112: the same lines, but somewhere an operator can actually reach.
    //
    // The logEvent above goes to the container's stdout, which is exactly the
    // place the 2026-09-03 run's twelve errors were lost from — it rotated
    // before anyone read it, and the only durable record, cron_runs.detail, said
    // `{"failures":{"errors":12}}`. `diagnostics` is read by readJobOutcome
    // (lib/cron-run-outcome.ts) and persisted to that same column, so the next
    // red run is diagnosable with one service-role query instead of SSH.
    //
    // Errors first and refusals in whatever room is left: readJobOutcome caps
    // the array at MAX_DIAGNOSTICS, and a refusal is a standing fact about the
    // keyset that the `notAuthorized` list in the response already names, while
    // an error is the thing that just went wrong and may never be seen again.
    const errorLines = boundedErrors.map((e) =>
      `subscribe failed for ${e.topicId}: ${e.message}`
    );
    const diagnostics = [
      ...errorLines,
      ...result.notAuthorized
        .slice(0, Math.max(0, MAX_DIAGNOSTICS - errorLines.length))
        .map((t) => `not authorized for topic ${t} on this keyset`),
    ];
    // US-3110 AC9: the topics eBay will not grant this keyset (403 / 195011).
    //
    // Logged separately from the errors above because the action is different in
    // kind. An entry here is never fixed by code or by a retry — someone has to
    // be granted the topic in the eBay developer portal, or we accept that the
    // bucket is served by the polling backstop instead. Naming them on one line
    // is what makes that decision possible without SSH.
    if (result.notAuthorized.length > 0) {
      logEvent("warn", "ebay_notification.topics_not_authorized", {
        env: result.env,
        count: result.notAuthorized.length,
        topics: result.notAuthorized.slice(0, MAX_LOGGED_ERRORS),
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
      notAuthorized: result.notAuthorized,
      errors: result.errors,
      // Persisted to cron_runs.detail by finishCronRun. Not a FAILURE_KEY, so
      // naming a failure cannot by itself turn a run red — `failed` below still
      // decides that.
      diagnostics,
      // US-3110 AC9: the ledger's failure signal is bucket HEALTH, not the
      // attempt log. `failed` is a FAILURE_KEY (lib/cron-run-outcome.ts), so a
      // required bucket left unsubscribed is recorded as an `error` run in
      // cron_runs and counts against success_rate.
      //
      // This had never been wired, and it is what makes the 195011 downgrade
      // above safe: before today the run went red because eBay refused twelve
      // topics, which happened to coincide with the pipeline being dead but did
      // not measure it. Now the red means the thing an operator cares about —
      // five of five required buckets have no enabled, correctly-routed
      // subscription, so no inbound eBay event reaches FlipDesk at all and
      // every sale, payout and return arrives only via the polling backstop.
      failed: result.health.missingBuckets.length,
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
      {
        error: "eBay notification reconcile failed",
        message: message.slice(0, 500),
        // US-3112: the throw path needs the ledger too. Every run from
        // 2026-08-20 onward failed HERE, and cron_runs.detail recorded `{}`
        // because a 500 body carries no counters — so 128 consecutive red runs
        // left no record of a single cause anywhere durable.
        diagnostics: [`reconcile threw: ${message}`],
      },
      500,
    );
  } finally {
    await lock.release();
  }
}
