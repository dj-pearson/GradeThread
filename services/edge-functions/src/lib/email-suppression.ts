/**
 * US-1057: Amazon SES deliverability — bounce/complaint suppression.
 *
 * SES posts bounce/complaint feedback to an SNS topic; the /api/webhooks/ses
 * route feeds those notifications here. A HARD bounce (bounceType=Permanent) or
 * a complaint suppresses the recipient; email.ts (`deliverEmail`) checks the
 * suppression list before every send and skips suppressed addresses, protecting
 * SES sender reputation. Transient bounces are intentionally NOT suppressed —
 * those addresses can recover and the outbox retry (US-498) handles them.
 */

import { supabaseAdmin } from "./supabase.ts";
import { captureException, recordMetric } from "./observability.ts";

export type SuppressionReason = "bounce" | "complaint" | "manual";

/** Trim + lowercase so lookups and writes use one canonical form. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ─── SES notification parsing (pure) ────────────────────────────────

export interface SesSuppression {
  emails: string[];
  reason: "bounce" | "complaint";
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
      reason: "bounce",
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

/**
 * True iff `email` is on the suppression list. FAILS OPEN: a lookup error must
 * not block legitimate transactional mail, so a DB hiccup returns false (and is
 * reported) rather than silently dropping every email.
 */
export async function isEmailSuppressed(email: string): Promise<boolean> {
  const addr = normalizeEmail(email);
  if (!addr) return false;
  const { data, error } = await supabaseAdmin
    .from("email_suppressions")
    .select("email")
    .eq("email", addr)
    .maybeSingle();
  if (error) {
    captureException(error, { route: "email-suppression.check" });
    return false;
  }
  return !!data;
}

/** Add (or refresh) a suppression entry. Best-effort — reports on failure. */
export async function suppressEmail(
  email: string,
  reason: SuppressionReason,
  detail?: string | null,
): Promise<void> {
  const addr = normalizeEmail(email);
  if (!addr) return;
  const { error } = await supabaseAdmin
    .from("email_suppressions")
    .upsert(
      { email: addr, reason, detail: detail ?? null, updated_at: new Date().toISOString() },
      { onConflict: "email" },
    );
  if (error) {
    captureException(error, { route: "email-suppression.suppress", tags: { reason } });
  } else {
    recordMetric("email.suppressed", 1, { reason });
  }
}

/**
 * Apply an SES feedback notification: suppress every recipient a permanent
 * bounce or complaint names. Returns the addresses actually suppressed (empty
 * for transient/non-suppressing notifications).
 */
export async function applySesFeedback(raw: unknown): Promise<string[]> {
  const parsed = parseSesNotification(raw);
  if (!parsed) return [];
  for (const addr of parsed.emails) {
    await suppressEmail(addr, parsed.reason, parsed.detail);
  }
  return parsed.emails;
}
