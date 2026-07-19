// Small shared helpers for sending account mail.
//
// Extracted from routes/webhooks.ts (US-2120) when a second caller appeared.
// They are six lines each, which is exactly the size at which copying feels
// cheaper than sharing — and exactly how this codebase ended up with two copies
// of title-sync, three cache-clear sites and four rounding implementations. One
// home, from the second caller onward.

/**
 * Fire an email send without letting a failure escape.
 *
 * Account mail is almost always on a path whose PRIMARY job is something else
 * (granting entitlement, downgrading a trial). A mail hiccup must never fail
 * that work, so this swallows and logs rather than rejecting.
 */
export function safeSendEmail(promise: Promise<boolean>, label: string): void {
  promise.catch((err) => {
    console.error(
      `[email] ${label} send failed:`,
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * A human first name for greetings, degrading gracefully.
 *
 * Falls back through full name → email local-part → "there", so a greeting is
 * never blank and never leaks a full address into a salutation.
 */
export function userDisplayName(
  email: string | null | undefined,
  fullName: string | null | undefined,
): string {
  if (fullName && fullName.trim()) return fullName.trim().split(/\s+/)[0]!;
  if (email) return email.split("@")[0]!;
  return "there";
}
