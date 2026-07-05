import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { router } from "@/routes";
import { queryClient } from "@/lib/query-client";
import { initAnalyticsFromStoredConsent } from "@/lib/analytics";
import { initSentry } from "@/lib/sentry";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </HelmetProvider>
  </StrictMode>
);
