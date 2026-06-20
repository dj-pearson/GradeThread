/**
 * Email suppression loop (US-1057 + US-914).
 *
 * SES posts bounce/complaint feedback to an SNS topic; the
 * /api/email/ses-notifications route (signature-verified) and the legacy
 * /api/webhooks/ses route feed those notifications here. A HARD bounce
 * (bounceType=Permanent) or a complaint suppresses the recipient; every send
 * path checks the suppression list before sending and skips suppressed
 * addresses (recording status='skipped'), protecting SES sender reputation so
 * autonomous, hands-off sending stays viable. Transient bounces are
 * intentionally NOT suppressed — those addresses can recover and the outbox
 * retry (US-498) handles them.
 *
 * US-914 additions: a complaint also flips the user's marketing consent off and
 * evaluates the rolling complaint rate — over a configurable threshold it raises
 * an ops alert and (when enabled) auto-pauses the newsletter program.
 */

import { supabaseAdmin } from "./supabase.ts";
import { captureException, recordMetric } from "./observability.ts";
import { bustSettingCache, getSetting } from "./system-settings.ts";
import { marketingOptedOutEmail } from "./drip-graph.ts";

// US-914 suppression reasons. 'hard_bounce' + 'complaint' come from SES;
// 'manual' is an operator add; 'unsubscribe_all' is a global opt-out.
export type SuppressionReason =
  | "hard_bounce"
  | "complaint"
  | "manual"
  | "unsubscribe_all";

/** Trim + lowercase so lookups and writes use one canonical form. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ─── SES notification parsing (pure) ────────────────────────────────

export interface SesSuppression {
  emails: string[];
  reason: "hard_bounce" | "complaint";
  detail: string;
}

interface SesRecipient {
  emailAddress?: string;
}

interface SesNotification {
  // SNS "SES notification" uses notificationType; the SES "event publishing"
  // flavor uses eventType. Accept either.
  notificationType?: string; // "Bounce" | "Complaint" | "Delivery"
  eventType?: string; // "Bounce" | "Complaint" | "Delivery" | ...
  bounce?: {
    bounceType?: string; // "Permanent" | "Transient" | "Undetermined"
    bounceSubType?: string;
    bouncedRecipients?: SesRecipient[];
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: SesRecipient[];
  };
}

function recipientEmails(recipients: SesRecipient[] | undefined): string[] {
  return (recipients ?? [])
    .map((r) => (r.emailAddress ? normalizeEmail(r.emailAddress) : ""))
    .filter((e) => e.length > 0);
}

/**
 * Decide, from a parsed SES notification, which recipients to suppress.
 * Returns null when nothing should be suppressed (a transient/undetermined
 * bounce, a delivery notification, or a malformed payload). Pure — no I/O — so
 * the suppression policy is unit-testable without a DB.
 */
export function parseSesNotification(raw: unknown): SesSuppression | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as SesNotification;
  const type = n.notificationType ?? n.eventType;

  if (type === "Bounce" && n.bounce) {
    // Only PERMANENT (hard) bounces auto-suppress; transient bounces recover.
    if (n.bounce.bounceType !== "Permanent") return null;
    const emails = recipientEmails(n.bounce.bouncedRecipients);
    if (emails.length === 0) return null;
    return {
      emails,
      reason: "hard_bounce",
      detail: `${n.bounce.bounceType}/${n.bounce.bounceSubType ?? "unknown"}`,
    };
  }

  if (type === "Complaint" && n.complaint) {
    const emails = recipientEmails(n.complaint.complainedRecipients);
    if (emails.length === 0) return null;
    return {
      emails,
      reason: "complaint",
      detail: n.complaint.complaintFeedbackType ?? "complaint",
    };
  }

  return null;
}

// ─── Suppression store (DB) ─────────────────────────────────────────

export interface SuppressionRecord {
  email: string;
  reason: SuppressionReason;
  source: string | null;
  notes: string | null;
  created_at?: string;
}

/**
 * Return the suppression row for `email`, or null. FAILS OPEN: a lookup error
 * must not block legitimate transactional mail, so a DB hiccup returns null
 * (and is reported) rather than silently dropping every email.
 */
export async function getSuppression(email: string): Promise<SuppressionRecord | null> {
  const addr = normalizeEmail(email);
  if (!addr) return null;
  const { data, error } = await supabaseAdmin
    .from("email_suppressions")
    .select("email, reason, source, notes")
    .eq("email", addr)
    .maybeSingle();
  if (error) {
    captureException(error, { route: "email-suppression.check" });
    return null;
  }
  return (data as SuppressionRecord | null) ?? null;
}

/** True iff `email` is on the suppression list (fails OPEN — see getSuppression). */
export async function isEmailSuppressed(email: string): Promise<boolean> {
  return (await getSuppression(email)) !== null;
}

/** Add (or refresh) a suppression entry. Best-effort — reports on failure. */
export async function suppressEmail(
  email: string,
  reason: SuppressionReason,
  opts?: { source?: string; notes?: string | null },
): Promise<void> {
  const addr = normalizeEmail(email);
  if (!addr) return;
  const notes = opts?.notes ?? null;
  const { error } = await supabaseAdmin
    .from("email_suppressions")
    .upsert(
      {
        email: addr,
        reason,
        source: opts?.source ?? "ses",
        // Keep the legacy `detail` column populated alongside the US-914 `notes`
        // column so older readers don't see a null.
        detail: notes,
        notes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email" },
    );
  if (error) {
    captureException(error, { route: "email-suppression.suppress", tags: { reason } });
  } else {
    recordMetric("email.suppressed", 1, { reason });
  }
}

/** Remove a suppression (admin false-positive correction). Returns true if a row existed. */
export async function removeSuppression(email: string): Promise<boolean> {
  const addr = normalizeEmail(email);
  if (!addr) return false;
  const { data, error } = await supabaseAdmin
    .from("email_suppressions")
    .delete()
    .eq("email", addr)
    .select("email")
    .maybeSingle();
  if (error) {
    captureException(error, { route: "email-suppression.remove" });
    return false;
  }
  return !!data;
}

/**
 * A complaint is the strongest possible opt-out signal — flip the recipient's
 * marketing consent off (notification_preferences.marketing.email = false, the
 * same flag the marketing coordinator's consent gate reads) so we never mail
 * them marketing again even if they're later removed from the suppression list.
 * Best-effort; never throws.
 */
async function disableMarketingConsent(email: string): Promise<void> {
  const addr = normalizeEmail(email);
  if (!addr) return;
  try {
    const { data } = await supabaseAdmin
      .from("users")
      .select("id, notification_preferences")
      .eq("email", addr)
      .maybeSingle();
    const row = data as
      | { id: string; notification_preferences: Record<string, unknown> | null }
      | null;
    if (!row) return;
    const prefs = row.notification_preferences ?? {};
    if (marketingOptedOutEmail(prefs)) return; // already opted out
    const marketing = (prefs["marketing"] as Record<string, unknown> | undefined) ?? {};
    const next = { ...prefs, marketing: { ...marketing, email: false } };
    const { error } = await supabaseAdmin
      .from("users")
      .update({ notification_preferences: next })
      .eq("id", row.id);
    if (error) {
      captureException(error, { route: "email-suppression.consent_off", level: "warn" });
    } else {
      recordMetric("email.complaint_consent_off", 1);
    }
  } catch (err) {
    captureException(err, { route: "email-suppression.consent_off", level: "warn" });
  }
}

export interface ComplaintRateOutcome {
  complaints: number;
  sends: number;
  rate: number;
  threshold: number;
  alerted: boolean;
  paused: boolean;
}

/**
 * Compute the rolling spam-complaint rate (complaints / marketing sends over the
 * configured window) and, when it breaches the configured threshold with enough
 * volume, raise an ops alert and (if auto-pause is enabled) pause the newsletter
 * program. Best-effort — never throws into the ingestion path.
 */
export async function evaluateComplaintRate(
  actorUserId?: string | null,
): Promise<ComplaintRateOutcome> {
  const empty: ComplaintRateOutcome = {
    complaints: 0,
    sends: 0,
    rate: 0,
    threshold: 0,
    alerted: false,
    paused: false,
  };
  try {
    const [threshold, windowHours, minVolume, autoPause] = await Promise.all([
      getSetting<number>("marketing_complaint_rate_threshold", 0.001),
      getSetting<number>("marketing_complaint_rate_window_hours", 24),
      getSetting<number>("marketing_complaint_rate_min_volume", 500),
      getSetting<boolean>("marketing_complaint_auto_pause", false),
    ]);
    const sinceIso = new Date(Date.now() - Math.max(1, windowHours) * 3_600_000).toISOString();

    const [complaintsRes, sendsRes] = await Promise.all([
      supabaseAdmin
        .from("email_suppressions")
        .select("email", { count: "exact", head: true })
        .eq("reason", "complaint")
        .gte("created_at", sinceIso),
      supabaseAdmin
        .from("marketing_send_log")
        .select("id", { count: "exact", head: true })
        .gte("sent_at", sinceIso),
    ]);
    const complaints = complaintsRes.count ?? 0;
    const sends = sendsRes.count ?? 0;
    const rate = sends > 0 ? complaints / sends : 0;

    const outcome: ComplaintRateOutcome = {
      complaints,
      sends,
      rate,
      threshold,
      alerted: false,
      paused: false,
    };

    if (sends < minVolume || rate < threshold) return outcome;

    // Over threshold: alert (best-effort) and optionally auto-pause.
    const { emitOpsEvent } = await import("./ops-events.ts");
    await emitOpsEvent("email.complaint_rate", "critical", {
      title: `Spam-complaint rate ${(rate * 100).toFixed(3)}% over threshold ${(threshold * 100).toFixed(3)}%`,
      source: "email-suppression",
      actorUserId: actorUserId ?? null,
      data: { complaints, sends, rate, threshold, windowHours, autoPause: Boolean(autoPause) },
    });
    outcome.alerted = true;

    if (autoPause) {
      const { error } = await supabaseAdmin
        .from("system_settings")
        .update({ value: true })
        .eq("key", "newsletter_send_paused");
      if (error) {
        captureException(error, { route: "email-suppression.auto_pause", level: "warn" });
      } else {
        bustSettingCache("newsletter_send_paused");
        outcome.paused = true;
        recordMetric("email.newsletter_auto_paused", 1);
      }
    }
    return outcome;
  } catch (err) {
    captureException(err, { route: "email-suppression.complaint_rate", level: "warn" });
    return empty;
  }
}

/**
 * Apply an SES feedback notification: suppress every recipient a permanent
 * bounce or complaint names. A complaint additionally flips marketing consent
 * off and re-evaluates the rolling complaint rate (alert / auto-pause). Returns
 * the addresses actually suppressed (empty for transient/non-suppressing
 * notifications). `source` defaults to 'ses'.
 */
export async function applySesFeedback(
  raw: unknown,
  source = "ses",
): Promise<string[]> {
  const parsed = parseSesNotification(raw);
  if (!parsed) return [];
  for (const addr of parsed.emails) {
    await suppressEmail(addr, parsed.reason, { source, notes: parsed.detail });
  }
  if (parsed.reason === "complaint") {
    for (const addr of parsed.emails) {
      await disableMarketingConsent(addr);
    }
    // Re-evaluate the rolling complaint rate once per notification.
    await evaluateComplaintRate();
  }
  return parsed.emails;
}
