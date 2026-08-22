// US-906: real-time ops activity feed + critical-event alerting.
//
// emitOpsEvent() is the ONE helper every significant platform event flows
// through. It (1) appends the event to ops_events for the admin Activity Feed,
// and (2) for severity >= the configured minimum (and a non-muted type), fans
// the event out to the configured channels (email + a generic webhook from the
// settings registry). Fan-out is best-effort and NEVER blocks the originating
// action — callers fire-and-forget with `void emitOpsEvent(...)`, and every
// failure here is swallowed (a webhook failure additionally dead-letters into
// the unified DLQ for visibility, AC#6).
//
// The routing decision (shouldFanOut / severityAtLeast) is pure + unit-tested;
// the channel config is read from system_settings so operators retune it
// without a deploy.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { sendOpsAlertEmail } from "./email.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";
import { captureException, recordMetric } from "./observability.ts";
import { routeOpsEventToAdmins } from "./admin-notifications.ts";

export type OpsEventSeverity = "info" | "warning" | "critical";

export const OPS_SEVERITIES: readonly OpsEventSeverity[] = [
  "info",
  "warning",
  "critical",
];

// Numeric rank for threshold comparisons.
const SEVERITY_RANK: Record<OpsEventSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function isOpsSeverity(v: unknown): v is OpsEventSeverity {
  return typeof v === "string" &&
    (OPS_SEVERITIES as readonly string[]).includes(v);
}

// `severity` is at least `min` (both ranked). An unknown value never qualifies.
export function severityAtLeast(
  severity: OpsEventSeverity,
  min: OpsEventSeverity,
): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

export interface OpsAlertConfig {
  enabled: boolean;
  minSeverity: OpsEventSeverity;
  webhookUrl: string;
  email: string;
  mutedTypes: string[];
}

// Pure routing decision: should an event of this (severity, type) fan out under
// this config? enabled AND severity >= minimum AND the type is not muted.
export function shouldFanOut(
  severity: OpsEventSeverity,
  type: string,
  config: OpsAlertConfig,
): boolean {
  if (!config.enabled) return false;
  if (!severityAtLeast(severity, config.minSeverity)) return false;
  if (config.mutedTypes.includes(type)) return false;
  return true;
}

// Read the alert config from the settings registry (short-TTL cached). Coerces a
// bad min-severity back to 'warning' and a non-array muted list to [].
export async function loadOpsAlertConfig(): Promise<OpsAlertConfig> {
  const [enabled, minRaw, webhookUrl, email, mutedRaw] = await Promise.all([
    getSetting<boolean>("ops_alert_enabled", true),
    getSetting<string>("ops_alert_min_severity", "warning"),
    getSetting<string>("ops_alert_webhook_url", ""),
    getSetting<string>("ops_alert_email", ""),
    getSetting<unknown>("ops_alert_muted_types", []),
  ]);
  const minSeverity = isOpsSeverity(minRaw) ? minRaw : "warning";
  const mutedTypes = Array.isArray(mutedRaw)
    ? mutedRaw.filter((x): x is string => typeof x === "string")
    : [];
  return {
    enabled: Boolean(enabled),
    minSeverity,
    webhookUrl: typeof webhookUrl === "string" ? webhookUrl.trim() : "",
    email: typeof email === "string" ? email.trim() : "",
    mutedTypes,
  };
}

// Resolve the effective channels: a configured registry value wins, else the
// long-standing MONITOR_ALERT_* / SMTP_ADMIN_EMAIL env fallbacks.
export function resolveAlertEmail(config: OpsAlertConfig): string {
  return config.email ||
    Deno.env.get("MONITOR_ALERT_EMAIL")?.trim() ||
    Deno.env.get("SMTP_ADMIN_EMAIL")?.trim() ||
    "";
}

export function resolveAlertWebhook(config: OpsAlertConfig): string {
  return config.webhookUrl ||
    Deno.env.get("MONITOR_ALERT_WEBHOOK")?.trim() ||
    "";
}

/**
 * US-2003 AC2: is there any channel at all, from the ENVIRONMENT alone?
 *
 * Deliberately does NOT read system_settings. This answers a boot-time
 * question, and the settings row needs a database round trip that a boot check
 * has no business blocking on - a monitoring check that can hang the start-up
 * of the thing it monitors is its own outage. The env half is also the half an
 * operator sets, so it is the half worth shouting about.
 *
 * A settings-only configuration therefore reads as "none" here and still works
 * at dispatch time. That is a false alarm in one direction, which is the safe
 * direction for this particular alarm: it says "check your alert channels",
 * and being told to check them when they are fine costs a minute.
 */
export function hasEnvAlertChannel(
  get: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  const keys = [
    "MONITOR_ALERT_WEBHOOK",
    "MONITOR_ALERT_EMAIL",
    "SMTP_ADMIN_EMAIL",
  ];
  return keys.some((k) => (get(k) ?? "").trim().length > 0);
}

export interface OpsEventInput {
  /** Human-readable one-liner for the feed. */
  title: string;
  /** Origin label (cron job name, 'maintenance', 'manual', …). */
  source?: string;
  /** Acting admin id, when human-initiated. */
  actorUserId?: string | null;
  /** Structured context (ids, counts, names). */
  data?: Record<string, unknown>;
  /**
   * US-909: explicit per-admin notification-center recipients (e.g. the assignee
   * of a ticket). When omitted, a critical event / job failure broadcasts to all
   * admins and any other event notifies no one (it stays in the activity feed).
   */
  notifyAdminIds?: string[];
}

export interface OpsAlertOutcome {
  webhookConfigured: boolean;
  webhookOk: boolean;
  emailConfigured: boolean;
  emailOk: boolean;
}

const WEBHOOK_TIMEOUT_MS = 5000;

// POST the alert to the generic webhook. Returns true on a 2xx; on any failure
// (non-2xx or throw) it dead-letters the attempt into webhook_dead_letters
// (provider 'ops-alert') for visibility (AC#6) and returns false. Never throws.
async function deliverWebhook(
  url: string,
  eventId: string,
  type: string,
  severity: OpsEventSeverity,
  title: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const summary = `[GradeThread ops] ${severity.toUpperCase()}: ${title}`;
  const body = {
    text: summary, // Slack
    summary, // PagerDuty/generic
    severity,
    type,
    title,
    event_id: eventId,
    payload: data,
  };
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      WEBHOOK_TIMEOUT_MS,
    );
    const ok = res.ok;
    const status = res.status;
    await res.body?.cancel();
    if (!ok) {
      await deadLetterWebhook(eventId, type, body, `webhook returned ${status}`);
    }
    return ok;
  } catch (err) {
    await deadLetterWebhook(
      eventId,
      type,
      body,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

// Record a failed alert-webhook delivery in the unified dead-letter store so it
// surfaces in the ops Dead Letters console. Best-effort; uses the ops_events row
// id as the dedupe event_id (unique per event).
async function deadLetterWebhook(
  eventId: string,
  eventType: string,
  payload: unknown,
  errorMessage: string,
): Promise<void> {
  try {
    await supabaseAdmin.from("webhook_dead_letters").insert({
      provider: "ops-alert",
      event_id: eventId,
      event_type: eventType,
      payload,
      error_message: errorMessage,
      status: "unresolved",
    });
    recordMetric("ops_event.alert_dead_lettered", 1, { type: eventType });
  } catch (err) {
    captureException(err, { route: "ops-events.dead_letter", level: "warn" });
  }
}

// Fan an event out to the configured channels. Returns a per-channel outcome.
// Email goes through the durable critical-email outbox (category 'ops_alert'),
// so a transient SMTP failure is retried/dead-lettered there automatically.
export async function dispatchOpsAlert(
  eventId: string,
  type: string,
  severity: OpsEventSeverity,
  title: string,
  data: Record<string, unknown>,
  config: OpsAlertConfig,
): Promise<OpsAlertOutcome> {
  const email = resolveAlertEmail(config);
  const webhook = resolveAlertWebhook(config);

  const [emailOk, webhookOk] = await Promise.all([
    email
      ? sendOpsAlertEmail(email, { type, severity, title, data }).catch((err) => {
        captureException(err, { route: "ops-events.alert.email", level: "warn" });
        return false;
      })
      : Promise.resolve(false),
    webhook
      ? deliverWebhook(webhook, eventId, type, severity, title, data)
      : Promise.resolve(false),
  ]);

  const outcome: OpsAlertOutcome = {
    webhookConfigured: Boolean(webhook),
    webhookOk,
    emailConfigured: Boolean(email),
    emailOk,
  };

  // US-2003 AC2: an alert that reached NOBODY is LOUD, not a metric.
  //
  // THE ARGUMENT FOR CHANGING THIS. A monitoring system that cannot page is
  // worse than none, because it produces false confidence - and the only record
  // of that state was `ops_event.alert_undelivered`, a metric which itself has
  // no alert. The one thing guaranteed not to reach anyone was the news that
  // nothing reaches anyone.
  //
  // TWO WAYS IT HAPPENS, and only the first was recorded at all:
  //   (a) NO channel is configured. The metric covered this.
  //   (b) Channels ARE configured and every one of them FAILED. Nothing
  //       recorded this. A webhook failure dead-letters, so that half is
  //       visible; an email-only deployment whose send fails left a warn-level
  //       exception and an outcome object nobody reads. That is the worse case
  //       of the two, because the health line reports alerting: ok throughout.
  //
  // So the condition is "did this land anywhere", not "was anything set up".
  if (!emailOk && !webhookOk) {
    // Kept, and now it means the narrower thing it always said: nothing was
    // even configured. That distinction is what tells an operator whether to
    // set a variable or to go and look at a broken endpoint.
    if (!email && !webhook) {
      recordMetric("ops_event.alert_undelivered", 1, { type });
    }
    recordMetric("ops_event.alert_reached_nobody", 1, { type });

    // captureException rather than a log line: this has to arrive somewhere a
    // human looks, and Sentry is the one channel that does not depend on the
    // configuration that just failed. Severity is the EVENT's own - a lost
    // `info` event is not worth waking anyone, and treating it as critical is
    // how a page becomes something people mute.
    if (severity === "critical" || severity === "warning") {
      captureException(
        new Error(
          `Ops alert reached no channel: ${type} (${severity}). ` +
            (email || webhook
              ? "Channels are configured and every one of them failed."
              : "No alert channel is configured at all."),
        ),
        {
          route: "ops-events.alert.reached_nobody",
          level: severity === "critical" ? "error" : "warn",
        },
      );
    }
  }
  return outcome;
}

/**
 * Record a significant platform event and (for severity >= the configured
 * minimum) fan it out to the alert channels. Best-effort and self-contained:
 * NEVER throws, so it can't disrupt the action that emitted it — callers should
 * fire-and-forget with `void emitOpsEvent(...)`.
 */
export async function emitOpsEvent(
  type: string,
  severity: OpsEventSeverity,
  payload: OpsEventInput,
): Promise<void> {
  const data = payload.data ?? {};
  try {
    // 1. Persist the event (the feed's source of truth).
    const { data: inserted, error } = await supabaseAdmin
      .from("ops_events")
      .insert({
        type,
        severity,
        title: payload.title,
        source: payload.source ?? null,
        actor_user_id: payload.actorUserId ?? null,
        payload: data,
      })
      .select("id")
      .maybeSingle();
    if (error || !inserted) {
      captureException(error ?? new Error("ops_events insert returned no row"), {
        route: "ops-events.emit",
        level: "warn",
        tags: { type },
      });
      return;
    }
    const eventId = (inserted as { id: string }).id;

    // 2. US-909: fan the event into the admin notification center (same
    // pipeline, not a parallel notifier). Self-contained / never throws.
    await routeOpsEventToAdmins({
      type,
      severity,
      title: payload.title,
      link: typeof data.link === "string" ? data.link : null,
      opsEventId: eventId,
      notifyAdminIds: payload.notifyAdminIds,
    });

    // 3. Fan out to alert channels if the routing config says so.
    const config = await loadOpsAlertConfig();
    if (!shouldFanOut(severity, type, config)) return;

    const outcome = await dispatchOpsAlert(eventId, type, severity, payload.title, data, config);
    await supabaseAdmin
      .from("ops_events")
      .update({
        fanned_out: true,
        delivered: outcome.webhookOk || outcome.emailOk,
      })
      .eq("id", eventId);
  } catch (err) {
    // Truly best-effort: a logging/alerting failure must never bubble to the
    // caller's request path.
    captureException(err, { route: "ops-events.emit", level: "warn", tags: { type } });
  }
}
