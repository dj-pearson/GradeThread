// Lazy Sentry loader (US-417 bundle budget). Keeps `@sentry/react` (~47 KB gz)
// OUT of the eager/cold-load chunk graph: Sentry is observability, not needed
// for first paint, so it loads after mount. The dynamic import is kicked off
// immediately (not awaited) so capture is available within milliseconds.
//
// ⚠️ NEVER add a top-level `import ... from "@sentry/react"` here or in any
// module the entry statically imports (main.tsx, error-boundary.tsx, the router
// shell) — that pulls the vendor-sentry chunk back into the eager graph and the
// bundle-budget CI gate (scripts/check-bundle-budget.mjs) fails again. The
// `typeof import(...)` below is a TYPE-only reference and is erased at build.

type SentryModule = typeof import("@sentry/react");
type CaptureCtx = Parameters<SentryModule["captureException"]>[1];

let sentryPromise: Promise<SentryModule> | null = null;

function loadSentry(): Promise<SentryModule> {
  if (!sentryPromise) sentryPromise = import("@sentry/react");
  return sentryPromise;
}

/**
 * Initialize Sentry after mount (no-op without a DSN). Fire-and-forget — error
 * monitoring runs under legitimate interest, so it's not gated by the cookie
 * banner. A crash in the first few ms before the chunk resolves is the accepted
 * trade for keeping it off the critical path.
 *
 * ⚠️ Privacy (GDPR): `sendDefaultPii` is FALSE. Sentry must not auto-attach the
 * end-user IP address or request headers — the IP is personal data and we run
 * this without prior consent for EU visitors under legitimate interest, which
 * only holds if we minimise. `beforeSend` also hard-nulls any IP that an
 * integration might still populate. Do NOT flip this back to `true`.
 */
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  void loadSentry().then((Sentry) => {
    Sentry.init({
      dsn,
      integrations: [Sentry.browserTracingIntegration()],
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      release: import.meta.env.VITE_RELEASE_SHA,
      // Defence-in-depth: strip the IP even if something sets it, so no raw
      // end-user IP ever reaches Sentry regardless of SDK defaults.
      beforeSend(event) {
        if (event.user) {
          delete event.user.ip_address;
          if (Object.keys(event.user).length === 0) delete event.user;
        }
        if (event.request?.headers) {
          delete event.request.headers["X-Forwarded-For"];
          delete event.request.headers["x-forwarded-for"];
        }
        return event;
      },
    });
  });
}

/** Capture an exception via the lazily-loaded Sentry (no-op without a DSN). */
export function captureException(error: unknown, context?: CaptureCtx): void {
  if (!import.meta.env.VITE_SENTRY_DSN) return;
  void loadSentry().then((Sentry) => Sentry.captureException(error, context));
}
