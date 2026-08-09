// US-2116 AC4: attach server-observed evidence to an email-signup clickwrap.
//
// Email signup defers the session until the confirmation link is clicked, so
// there is no authenticated request at signUp() time and the consent row is
// written by a Postgres trigger with no IP and no user-agent. The first
// authenticated session is the earliest moment the server can observe anything
// about the person, which is why this fires there.
//
// It is a CORROBORATION, not a backfill of the signup request — the rules, and
// the two tempting shortcuts they rule out, live in the edge module
// services/edge-functions/src/lib/signup-consent-evidence.ts. Read that before
// changing anything here.
//
// Lazy Sentry façade for the same reason welcome-email.ts uses one (US-2332):
// this module is reached from use-auth.ts, and a static @sentry/react import
// here drags the 475 KB vendor chunk into every lazily-loaded route.
import { captureException } from "@/lib/sentry";
import { edgeFetch } from "@/lib/edge-fetch";

// Users already attempted in this page session. The SERVER is the real
// idempotency guard (legal_acceptances is append-only, so a lost race is a
// permanent duplicate in an audit table, not a harmless retry) — this only
// stops the same tab re-asking after a token refresh re-fires SIGNED_IN.
const attempted = new Set<string>();

/** Exported for tests; page sessions are otherwise the only reset. */
export function resetSignupConsentAttempts(): void {
  attempted.clear();
}

/**
 * Fire once per user per page session. Safe to call on every SIGNED_IN.
 *
 * `provider` gates OAuth out on the client as well as the server: an OAuth
 * signup has no clickwrap row to corroborate (the trigger only writes one when
 * the clickwrap metadata is present), and its consent already goes through
 * /api/legal/accept, which records IP and user-agent itself. The server refuses
 * those callers anyway — this just keeps a request off every Google sign-in.
 */
export function confirmSignupConsentOnce(
  userId: string,
  provider: string | undefined,
): void {
  if (!userId) return;
  if (provider !== "email") return;
  if (attempted.has(userId)) return;
  attempted.add(userId);

  void (async () => {
    try {
      // Personal-account action, so no workspace header; silentGate so a plan
      // banner never fires off a background compliance ping. Fire-and-forget:
      // a failure must never block sign-in, and the next session retries.
      await edgeFetch("/api/legal/confirm-signup", {
        method: "POST",
        json: {},
        skipWorkspaceHeader: true,
        silentGate: true,
      });
      // No status check on purpose. The endpoint answers 200 for "already
      // confirmed" and for "nothing to corroborate", both of which are normal
      // and neither of which is worth a breadcrumb. A 5xx is already captured
      // server-side with the reason, which the client cannot see.
    } catch (e) {
      // Let the attempt be retried on the next session rather than the next
      // token refresh: a network blip should not burn the record for good, but
      // hammering it within one page session is not a retry strategy.
      attempted.delete(userId);
      captureException(e, { tags: { area: "auth.signup_consent" } });
    }
  })();
}
