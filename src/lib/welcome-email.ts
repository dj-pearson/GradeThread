import * as Sentry from "@sentry/react";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1433: fire the welcome email once per account, on the first authenticated
// session — regardless of signup method (email OR OAuth). Previously the trigger
// lived only in the email-signup handler, so Google/Apple signups never got a
// welcome; that handler also POSTed to VITE_SUPABASE_URL (`api.*`), where the
// `/api/*` Hono routes 404, so it likely never reached the edge at all. This
// helper uses the correct edge base (functions.*) and is fire-and-forget with a
// Sentry capture on failure so a broken pipeline is visible but never blocks the
// UI. The server endpoint is idempotent (a user_metadata flag), so calling this
// on every SIGNED_IN is safe — a returning user is a no-op.
export function sendWelcomeEmailOnce(userId: string): void {
  if (!userId) return;
  // US-1638: the endpoint is now authenticated and derives the target from the
  // verified token (no body userId — that was an account-existence oracle). Use
  // edgeFetch so the fresh access token is attached (+ 401-refresh-retry).
  // Personal-account action → skip the workspace header; silentGate so a plan
  // banner never fires off a background welcome ping. Fire-and-forget.
  void (async () => {
    try {
      const res = await edgeFetch("/api/notifications/welcome", {
        method: "POST",
        json: {},
        skipWorkspaceHeader: true,
        silentGate: true,
      });
      if (!res.ok) {
        Sentry.captureMessage("welcome email request failed", {
          level: "warning",
          extra: { status: res.status },
        });
      }
    } catch (e) {
      Sentry.captureException(e, { tags: { area: "auth.welcome_email" } });
    }
  })();
}
