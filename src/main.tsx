import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import * as Sentry from "@sentry/react";
import { router } from "@/routes";
import { initAnalyticsFromStoredConsent } from "@/lib/analytics";
import "@/index.css";

// Initialize Sentry (conditional). Error monitoring is not gated by the cookie
// banner — it runs under legitimate interest with no advertising signals.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
    sendDefaultPii: true,
    release: import.meta.env.VITE_RELEASE_SHA,
  });
}

// Analytics (Google Analytics + PostHog) are consent-gated. Returning visitors
// who already opted in get analytics restored here; first-time visitors see the
// cookie banner (rendered in RootLayout) and stay un-tracked until they accept.
initAnalyticsFromStoredConsent();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </HelmetProvider>
  </StrictMode>
);
