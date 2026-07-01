import * as Sentry from "@sentry/react";
import { edgeApiUrl } from "@/lib/edge-api";

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
  let base: string;
  try {
    base = edgeApiUrl();
  } catch {
    // Edge URL not configured (e.g. local build without env) — nothing to do.
    return;
  }
  fetch(`${base}/api/notifications/welcome`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  })
    .then((res) => {
      if (!res.ok) {
        Sentry.captureMessage("welcome email request failed", {
          level: "warning",
          extra: { status: res.status },
        });
      }
    })
    .catch((e) => {
      Sentry.captureException(e, { tags: { area: "auth.welcome_email" } });
    });
}
