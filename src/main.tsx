import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { router } from "@/routes";
import { queryClient } from "@/lib/query-client";
import { initAnalyticsFromStoredConsent } from "@/lib/analytics";
import { initSentry } from "@/lib/sentry";
import { captureUtms, captureClickIds } from "@/lib/ad-attribution";
import { initAdAttributionSync } from "@/lib/ad-attribution-sync";
import { initUtmAttributionSync } from "@/lib/utm-attribution-sync";
import "@/index.css";

// Stale-chunk guard. After a deploy, an already-open tab (or a stale PWA
// service-worker precache) can still reference lazy-chunk hashes from the
// previous build. When one of those dynamic imports 404s, Vite fires
// `vite:preloadError` — instead of white-screening, reload once to pull the
// fresh index.html + current chunks. The sessionStorage flag makes it reload
// at most once per tab session, so a chunk that is genuinely gone can't cause
// an infinite reload loop (the ErrorBoundary takes over after the one retry).
window.addEventListener("vite:preloadError", () => {
  const KEY = "gt:preloadErrorReloaded";
  if (sessionStorage.getItem(KEY)) return;
  sessionStorage.setItem(KEY, "1");
  window.location.reload();
});

// Initialize Sentry (conditional, lazy). Error monitoring is not gated by the
// cookie banner — it runs under legitimate interest with no advertising signals.
// Loaded via dynamic import (see lib/sentry.ts) so @sentry/react stays out of
// the eager/cold-load chunk graph (US-417 bundle budget).
initSentry();

// Analytics (Google Analytics + PostHog) are consent-gated. Returning visitors
// who already opted in get analytics restored here; first-time visitors see the
// cookie banner (rendered in RootLayout) and stay un-tracked until they accept.
initAnalyticsFromStoredConsent();

// US-1700: capture Google click ids (gclid/gbraid/wbraid) from the landing URL
// into first-party storage, and persist them to the converting user once signed
// in. Click ids aren't PII and this runs independent of the analytics consent
// gate (first-party attribution, no third-party advertising signals set here).
captureClickIds();
// US-2101: UTM channel capture. Unlike click ids above, this IS consent-gated
// (captureUtms checks analytics consent internally and fails closed) — utm tags
// describe a marketing channel rather than being an opaque first-party click
// identifier, so it belongs behind the same gate as analytics.
captureUtms();
initAdAttributionSync();
// US-2101 AC2: persist the captured UTMs to the user row once authenticated,
// same lifecycle as the click-id sync above.
initUtmAttributionSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
  </StrictMode>
);
