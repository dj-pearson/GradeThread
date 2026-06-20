// US-912: standalone email-subscriber capture — PURE helpers.
//
// Dependency-free (no supabase / env / network) so the validation + status
// mapping have one source of truth and unit-test without a DB. The DB-touching
// subscribe/confirm flow lives in routes/newsletter-subscribe.ts; the suppression
// linkage lives in lib/email-suppression.ts.

import type { SuppressionReason } from "./email-suppression.ts";

/** Trim + lowercase so the list keys on one canonical email form (mirrors
 * email-suppression.normalizeEmail / broadcast-audience.normalizeBroadcastEmail). */
export function normalizeSubscriberEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}

// Deliberately conservative: a single @, a non-empty local part, a dotted domain
// with a 2+ char TLD, no whitespace. Bad addresses are rejected at the door so
// the confirmation send (and SES reputation) isn't wasted on garbage. The real
// proof of deliverability is the double-opt-in confirm click.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** True iff `email` (already normalized) is a plausibly-deliverable address. */
export function isValidSubscriberEmail(email: string): boolean {
  const addr = normalizeSubscriberEmail(email);
  return addr.length <= 254 && EMAIL_RE.test(addr);
}

/**
 * Map an SES/suppression reason onto the subscriber-list status so a standalone
 * lead's row reflects suppression identically to a registered user (AC4):
 *   • hard_bounce          → 'bounced'      (undeliverable address)
 *   • complaint / unsub /  → 'unsubscribed' (explicit or strong opt-out)
 *     manual
 * Returns null for any reason that should NOT change the subscriber's status.
 */
export function subscriberStatusForSuppression(
  reason: SuppressionReason,
): "bounced" | "unsubscribed" | null {
  switch (reason) {
    case "hard_bounce":
      return "bounced";
    case "complaint":
    case "unsubscribe_all":
    case "manual":
      return "unsubscribed";
    default:
      return null;
  }
}
