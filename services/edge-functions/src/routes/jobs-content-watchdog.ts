// US-869: content scheduler + webhook watchdog.
//
// Once the content engine is auto-publishing (US-852) a silent stall is
// dangerous — a disabled cron, a crash-looping container, or a missing
// content_settings row would publish nothing and nobody would notice. This
// cron is the heartbeat check: it flags
//   (a) a STALLED scheduler — no healthy (non-error) content_scheduler_runs
//       tick in the trailing 3 hours (the scheduler writes one heartbeat row
//       per tick; see content-scheduler.ts recordSchedulerRun), and
//   (b) ELEVATED webhook failures — over the trailing 24h, more than 25% of
//       content_webhook_log attempts failed (succeeded=false), guarded by a
//       minimum sample so a single failed attempt can't trip it.
// On either flag it emails the owner via the existing notification path (NOT a
// silent log) and, when configured, pings the ops webhook too.
//
// Mounted in main.ts as POST /api/jobs/content-watchdog, OUTSIDE /api/* JWT
// groups; the handler enforces X-Internal-Job-Secret itself (same pattern as
// the other Coolify crons — grading-monitor, north-star-digest).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { sendContentWatchdogAlertEmail } from "../lib/email.ts";
import { captureException, recordMetric } from "../lib/observability.ts";

const STALE_TICK_HOURS = 3;
const WEBHOOK_WINDOW_HOURS = 24;
// Sample guard: with too few attempts a single failure isn't a signal. 4 keeps
// us from paging on a one-off blip while still catching a real outage fast.
const MIN_WEBHOOK_ATTEMPTS = 4;
const MAX_WEBHOOK_FAILURE_RATE = 0.25;
const HOUR_MS = 60 * 60 * 1000;

export interface WatchdogThresholds {
  staleTickHours: number;
  minWebhookAttempts: number;
  maxWebhookFailureRate: number;
}

export function watchdogThresholds(): WatchdogThresholds {
  return {
    staleTickHours: STALE_TICK_HOURS,
    minWebhookAttempts: MIN_WEBHOOK_ATTEMPTS,
    maxWebhookFailureRate: MAX_WEBHOOK_FAILURE_RATE,
  };
}

export interface WatchdogInputs {
  nowMs: number;
  // Epoch ms of the most recent HEALTHY (non-error) scheduler tick, or null if
  // there has never been one in the lookback window.
  lastHealthyTickMs: number | null;
  // Trailing-24h content_webhook_log stats.
  webhookAttempts: number;
  webhookFailures: number;
}

export interface WatchdogFlag {
  code: "stalled_scheduler" | "elevated_webhook_failures";
  message: string;
}

export interface WatchdogResult {
  flags: WatchdogFlag[];
  hoursSinceHealthyTick: number | null;
  webhookAttempts: number;
  webhookFailures: number;
}

/**
 * Decide which conditions the watchdog flags. Pure — no DB/email — so the
 * 3-hour stall window and the 25%-failure threshold are unit-testable
 * (jobs-content-watchdog_test.ts).
 */
export function evaluateWatchdog(
  inputs: WatchdogInputs,
  t: WatchdogThresholds,
): WatchdogResult {
  const flags: WatchdogFlag[] = [];

  const hoursSinceHealthyTick = inputs.lastHealthyTickMs == null
    ? null
    : (inputs.nowMs - inputs.lastHealthyTickMs) / HOUR_MS;

  // (a) Stalled scheduler: no healthy tick ever, or the last one is older than
  // the stall window.
  if (
    hoursSinceHealthyTick == null ||
    hoursSinceHealthyTick > t.staleTickHours
  ) {
    flags.push({
      code: "stalled_scheduler",
      message: hoursSinceHealthyTick == null
        ? `Scheduler stalled: no healthy tick on record in the lookback window ` +
          `(expected one at least every ${t.staleTickHours}h).`
        : `Scheduler stalled: last healthy tick was ${
          hoursSinceHealthyTick.toFixed(1)
        }h ago (threshold ${t.staleTickHours}h).`,
    });
  }

  // (b) Elevated webhook failure rate, with a minimum-sample guard.
  if (inputs.webhookAttempts >= t.minWebhookAttempts) {
    const rate = inputs.webhookFailures / inputs.webhookAttempts;
    if (rate > t.maxWebhookFailureRate) {
      flags.push({
        code: "elevated_webhook_failures",
        message: `Webhook failure rate ${(rate * 100).toFixed(1)}% over the ` +
          `trailing 24h (${inputs.webhookFailures}/${inputs.webhookAttempts}) ` +
          `exceeds the ${(t.maxWebhookFailureRate * 100).toFixed(0)}% threshold.`,
      });
    }
  }

  return {
    flags,
    hoursSinceHealthyTick,
    webhookAttempts: inputs.webhookAttempts,
    webhookFailures: inputs.webhookFailures,
  };
}

// Gather the two signals the watchdog evaluates. Separated from evaluate() so
// the threshold logic stays pure and testable.
async function gatherInputs(nowMs: number): Promise<WatchdogInputs> {
  // Most recent HEALTHY (non-error) heartbeat. Service-role bypasses RLS.
  const { data: tick } = await supabaseAdmin
    .from("content_scheduler_runs")
    .select("ran_at")
    .neq("outcome", "error")
    .order("ran_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastHealthyTickMs = tick?.ran_at
    ? new Date(tick.ran_at as string).getTime()
    : null;

  // Webhook attempts over the trailing 24h.
  const since = new Date(nowMs - WEBHOOK_WINDOW_HOURS * HOUR_MS).toISOString();
  const { data: rows } = await supabaseAdmin
    .from("content_webhook_log")
    .select("succeeded")
    .gte("created_at", since);
  const attempts = (rows ?? []) as Array<{ succeeded: boolean }>;
  const webhookAttempts = attempts.length;
  const webhookFailures = attempts.filter((r) => r.succeeded === false).length;

  return { nowMs, lastHealthyTickMs, webhookAttempts, webhookFailures };
}

// Fire the owner alert. Email is the required channel (AC#4); the ops webhook
// (CONTENT_ALERT_WEBHOOK, falling back to MONITOR_ALERT_WEBHOOK) is best-effort
// parity with content-webhook.ts. Returns true iff at least one channel
// delivered, so the caller can report an undelivered alert rather than going
// quiet.
async function notifyOwner(result: WatchdogResult): Promise<boolean> {
  const flagLines = result.flags.map((f) => f.message);
  let delivered = false;

  const to = Deno.env.get("CONTENT_ALERT_EMAIL")?.trim() ||
    Deno.env.get("MONITOR_ALERT_EMAIL")?.trim() ||
    Deno.env.get("SMTP_ADMIN_EMAIL")?.trim() ||
    "";
  if (to) {
    try {
      const ok = await sendContentWatchdogAlertEmail(to, {
        flags: flagLines,
        hoursSinceHealthyTick: result.hoursSinceHealthyTick,
        webhookAttempts: result.webhookAttempts,
        webhookFailures: result.webhookFailures,
      });
      if (ok) delivered = true;
    } catch (err) {
      captureException(err, { route: "content-watchdog.alert.email" });
    }
  }

  const hook = Deno.env.get("CONTENT_ALERT_WEBHOOK")?.trim() ||
    Deno.env.get("MONITOR_ALERT_WEBHOOK")?.trim() ||
    "";
  if (hook) {
    const summary = `[GradeThread content watchdog] ${flagLines.join(" | ")}`;
    try {
      const res = await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: summary, // Slack
          summary, // PagerDuty/generic
          codes: result.flags.map((f) => f.code),
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) delivered = true;
      await res.body?.cancel();
    } catch (err) {
      captureException(err, { route: "content-watchdog.alert.webhook" });
    }
  }

  if (!delivered) {
    // A raised alert that reached NO channel must itself be reported.
    recordMetric("content_watchdog.alert_undelivered", 1);
    captureException(
      new Error(
        `content-watchdog flagged ${result.flags.length} condition(s) but NO ` +
          `channel delivered — set CONTENT_ALERT_EMAIL/SMTP_ADMIN_EMAIL or ` +
          `CONTENT_ALERT_WEBHOOK/MONITOR_ALERT_WEBHOOK.`,
      ),
      { level: "warn", route: "content-watchdog.alert" },
    );
  }
  return delivered;
}

export async function handleContentWatchdogCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("content-watchdog", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const nowMs = Date.now();
    const inputs = await gatherInputs(nowMs);
    const result = evaluateWatchdog(inputs, watchdogThresholds());

    let alerted = false;
    if (result.flags.length > 0) {
      alerted = await notifyOwner(result);
      console.warn(
        `[content-watchdog] flagged: ${
          result.flags.map((f) => f.code).join(", ")
        } (alerted=${alerted})`,
      );
    }

    return c.json({
      ok: true,
      flagged: result.flags.length > 0,
      alerted,
      flags: result.flags,
      hours_since_healthy_tick: result.hoursSinceHealthyTick,
      webhook_attempts: result.webhookAttempts,
      webhook_failures: result.webhookFailures,
    });
  } finally {
    await lock.release();
  }
}
