// US-934: marketing send coordinator — the single chokepoint EVERY marketing
// email routes through. It resolves the policy inputs from the DB + settings
// registry, applies the pure decision (lib/marketing-frequency.ts), and then:
//   • SEND  → delivers now (durably, via the email_deliveries outbox on failure)
//             and records the send in the unified marketing_send_log so the
//             per-recipient daily cap is enforced ACROSS all programs.
//   • DEFER → re-queues the rendered email into the email_deliveries outbox with
//             a future next_attempt_at (the US-498 retry cron sends it later), so
//             a frequency-capped / quiet-hours / drip-paused send is NOT lost.
//   • DROP  → the recipient opted out (US-911) or is suppressed (US-914); the
//             email is discarded (re-queuing would never become sendable).
//
// Consent (US-911) + suppression (US-914) are checked HERE as the single
// chokepoint, so individual senders don't each re-implement (and drift on) the
// policy. Transactional mail must NOT route through here — it is never capped.

import { supabaseAdmin } from "./supabase.ts";
import { captureException, recordMetric } from "./observability.ts";
import { isEmailSuppressed, normalizeEmail } from "./email-suppression.ts";
import { marketingOptedOutEmail } from "./drip-graph.ts";
import { getSetting } from "./system-settings.ts";
import { deliverEmail } from "./email.ts";
import { marketingUnsubscribeUrl } from "./unsubscribe.ts";
import {
  DEFAULT_FREQUENCY_CAP_PER_DAY,
  DEFAULT_QUIET_HOURS,
  evaluateMarketingSend,
  type MarketingSendAction,
  type MarketingSource,
  msUntilLocalHour,
  msUntilLocalMidnight,
  normalizeQuietHours,
} from "./marketing-frequency.ts";

// Settings-registry keys (seeded in migration 00276; tunable without a deploy).
export const FREQUENCY_CAP_SETTING = "marketing_frequency_cap_per_day";
export const QUIET_HOURS_SETTING = "marketing_quiet_hours";

export interface CoordinateMarketingInput {
  /** Recipient email address. */
  to: string;
  /** Recipient user id (for the log + drip-enrollment precedence lookup). */
  userId?: string | null;
  /** Already-loaded notification_preferences blob; looked up by userId if absent. */
  prefs?: Record<string, unknown> | null;
  source: MarketingSource;
  /** Outbox category (drives retry/dead-lettering + traceability). */
  category: string;
  subject: string;
  /** FULLY-rendered HTML — layout + CAN-SPAM footer + unsubscribe + any tracking
   * must already be applied by the caller (this layer only gates + delivers). */
  html: string;
  /** Override "now" (ms) for tests / deterministic callers. */
  nowMs?: number;
}

export interface CoordinateMarketingResult {
  action: MarketingSendAction;
  reason: string;
  /** SMTP accepted the live send (or it was durably enqueued for retry). */
  sent: boolean;
  /** The send was deferred (re-queued for a later window). */
  deferred: boolean;
}

/** Recipient's local hour/minute in `tz` (falls back to UTC on a bad tz). */
function localHourMinute(nowMs: number, tz: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return {
      hour: Number.isFinite(hour) ? hour % 24 : 0,
      minute: Number.isFinite(minute) ? minute : 0,
    };
  } catch {
    const d = new Date(nowMs);
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
}

/** Count marketing emails already sent to `recipient` since `sinceIso`. */
async function countSentSince(recipient: string, sinceIso: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("marketing_send_log")
    .select("id", { count: "exact", head: true })
    .eq("recipient", recipient)
    .gte("sent_at", sinceIso);
  if (error) {
    // Fail OPEN on the cap read: a DB hiccup must not silently swallow mail, and
    // the per-program gates (drip frequency cap) still bound the blast radius.
    captureException(error, { route: "marketing-coordinator.count" });
    return 0;
  }
  return count ?? 0;
}

/** Is this recipient currently enrolled in (not yet exited) the trial drip? */
async function isEnrolledInDrip(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await supabaseAdmin
    .from("drip_enrollments")
    .select("id")
    .eq("user_id", userId)
    .is("exited_at", null)
    .is("converted_at", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    captureException(error, { route: "marketing-coordinator.drip-enrollment" });
    return false;
  }
  return !!data;
}

/** Record a marketing send in the unified cross-program ledger (best-effort). */
export async function recordMarketingSend(
  recipient: string,
  source: MarketingSource,
  category: string,
  ownerUserId?: string | null,
): Promise<void> {
  const addr = normalizeEmail(recipient);
  if (!addr) return;
  const { error } = await supabaseAdmin.from("marketing_send_log").insert({
    recipient: addr,
    source,
    category,
    owner_user_id: ownerUserId ?? null,
  });
  if (error) {
    captureException(error, { route: "marketing-coordinator.record" });
  }
}

/** Re-queue a deferred marketing email into the outbox for a later attempt. */
async function enqueueDeferred(
  recipient: string,
  subject: string,
  html: string,
  category: string,
  deferMs: number,
  reason: string,
): Promise<void> {
  const nextAttemptIso = new Date(Date.now() + Math.max(60_000, deferMs)).toISOString();
  const { error } = await supabaseAdmin.from("email_deliveries").insert({
    recipient,
    subject,
    html,
    category,
    status: "pending",
    attempts: 0,
    next_attempt_at: nextAttemptIso,
    last_error: `deferred:${reason}`,
  });
  if (error) {
    captureException(error, { route: "marketing-coordinator.defer", tags: { reason } });
  } else {
    recordMetric("marketing.deferred", 1, { reason, category });
  }
}

/**
 * Resolve the marketing-send policy for one recipient and act on it. Returns the
 * decision + whether anything went out / was deferred. The ONLY entry point a
 * marketing sender should use.
 */
export async function coordinateMarketingSend(
  input: CoordinateMarketingInput,
): Promise<CoordinateMarketingResult> {
  const nowMs = input.nowMs ?? Date.now();
  const addr = normalizeEmail(input.to);
  if (!addr) {
    recordMetric("marketing.dropped", 1, { reason: "no_address", source: input.source });
    return { action: "drop", reason: "no_address", sent: false, deferred: false };
  }

  // 1. Consent (US-911): prefer the passed blob; else look it up.
  let prefs = input.prefs ?? null;
  if (prefs === null && input.userId) {
    const { data } = await supabaseAdmin
      .from("users")
      .select("notification_preferences")
      .eq("id", input.userId)
      .maybeSingle();
    prefs = (data as { notification_preferences: Record<string, unknown> | null } | null)
      ?.notification_preferences ?? null;
  }
  const optedOut = marketingOptedOutEmail(prefs);

  // 2. Suppression (US-914) — only worth a round-trip when consent is intact.
  const suppressed = optedOut ? false : await isEmailSuppressed(addr);

  // 3. Config (tunable via the settings registry).
  const capPerDay = await getSetting(FREQUENCY_CAP_SETTING, DEFAULT_FREQUENCY_CAP_PER_DAY);
  const quietHours = normalizeQuietHours(
    await getSetting<unknown>(QUIET_HOURS_SETTING, DEFAULT_QUIET_HOURS),
  );

  // 4. Timing in the recipient's quiet-hours tz.
  const { hour: localHour, minute: localMinute } = localHourMinute(nowMs, quietHours.timezone);
  const msUntilWindowReset = msUntilLocalMidnight(localHour, localMinute);
  const msUntilQuietEnd = msUntilLocalHour(localHour, localMinute, quietHours.endHour);

  // 5. Counts + precedence — skipped when an earlier permanent stop already fires
  //    (a dropped recipient needs no cap/precedence round-trips).
  const blockedEarly = optedOut || suppressed;
  const windowStartMs = nowMs - (localHour * 60 + localMinute) * 60_000;
  const sentInWindow = blockedEarly
    ? 0
    : await countSentSince(addr, new Date(windowStartMs).toISOString());
  // Drip precedence only matters for the lower-precedence programs.
  const needsDripCheck = !blockedEarly &&
    (input.source === "weekly_newsletter" || input.source === "journey");
  const enrolledInDrip = needsDripCheck ? await isEnrolledInDrip(input.userId) : false;

  const decision = evaluateMarketingSend({
    source: input.source,
    optedOut,
    suppressed,
    sentInWindow,
    capPerDay,
    enrolledInDrip,
    localHour,
    quietHours,
    msUntilWindowReset,
    msUntilQuietEnd,
  });

  if (decision.action === "drop") {
    recordMetric("marketing.dropped", 1, { reason: decision.reason, source: input.source });
    return { action: "drop", reason: decision.reason, sent: false, deferred: false };
  }

  if (decision.action === "defer") {
    await enqueueDeferred(
      addr,
      input.subject,
      input.html,
      input.category,
      decision.deferMs ?? msUntilWindowReset,
      decision.reason,
    );
    return { action: "defer", reason: decision.reason, sent: false, deferred: true };
  }

  // SEND: deliver now; on a transient SMTP failure persist to the outbox so the
  // retry cron re-attempts (the message is durable either way). Both count as a
  // send for the cap ledger.
  //
  // US-915: this is the single marketing chokepoint, so it routes the send on the
  // dedicated marketing identity + SES Configuration Set and stamps the one-click
  // List-Unsubscribe header. Mint the no-login unsubscribe URL from the userId
  // (the same link the rendered footer already carries) so Gmail/Apple Mail show
  // the native unsubscribe affordance (RFC 8058).
  const unsubscribeUrl = input.userId
    ? await marketingUnsubscribeUrl(input.userId).catch(() => undefined)
    : undefined;
  const delivered = await deliverEmail({
    to: addr,
    subject: input.subject,
    html: input.html,
    category: input.category,
    marketing: true,
    unsubscribeUrl: unsubscribeUrl ?? undefined,
  });
  if (!delivered) {
    await enqueueDeferred(addr, input.subject, input.html, input.category, 60_000, "smtp_retry");
  }
  await recordMarketingSend(addr, input.source, input.category, input.userId);
  recordMetric("marketing.sent", 1, { source: input.source, category: input.category });
  return { action: "send", reason: decision.reason, sent: true, deferred: false };
}
