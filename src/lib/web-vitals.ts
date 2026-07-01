// Real-user Core Web Vitals reporting (US-305).
//
// Captures LCP, INP, CLS, and TTFB with Google's web-vitals library and sends
// them to the same analytics sinks the rest of the app uses (Google Analytics
// via gtag + PostHog). This is CONSENT-GATED: startWebVitals() is called only
// from startAnalytics() (src/lib/analytics.ts), which runs after the visitor
// opts in via the cookie banner — so no measurement leaves the device until
// then. The March 2026 core update weights the "good" CWV band more heavily,
// and INP < 200ms is the most-failed metric, so we surface all four.

import type { Metric } from "web-vitals";

export interface VitalEvent {
  /** Metric short name, e.g. "LCP". */
  name: string;
  /** Rounded metric value. CLS is unitless (×1000 → integer); others are ms. */
  value: number;
  /** web-vitals rating: "good" | "needs-improvement" | "poor". */
  rating: string;
  /** Unique id for the metric instance (dedupes deltas). */
  id: string;
  /** Navigation type reported by web-vitals (navigate, reload, back-forward…). */
  navigationType: string;
}

/**
 * Map a raw web-vitals Metric into a clean analytics payload. Pure + testable.
 * CLS is a unitless ratio, so it's scaled by 1000 and rounded to an integer
 * (GA/PostHog numeric fields prefer integers); time metrics round to whole ms.
 */
export function buildVitalEvent(metric: Metric): VitalEvent {
  const value =
    metric.name === "CLS"
      ? Math.round(metric.value * 1000)
      : Math.round(metric.value);
  return {
    name: metric.name,
    value,
    rating: metric.rating,
    id: metric.id,
    navigationType: metric.navigationType,
  };
}

/** Send a vital to GA (event) + PostHog (capture) if each is present. */
function sendVital(event: VitalEvent): void {
  // Google Analytics — only fires when Consent Mode is granted (gtag exists +
  // analytics_storage was flipped to granted in startAnalytics).
  window.gtag?.("event", "web_vitals", {
    metric_name: event.name,
    metric_value: event.value,
    metric_rating: event.rating,
    metric_id: event.id,
    navigation_type: event.navigationType,
    // Non-interaction so it doesn't affect bounce/engagement.
    non_interaction: true,
  });

  // PostHog — captured on the already-initialized instance, if loaded.
  const ph = (window as unknown as { posthog?: { capture?: (e: string, p: unknown) => void } })
    .posthog;
  ph?.capture?.("web_vitals", {
    metric_name: event.name,
    metric_value: event.value,
    metric_rating: event.rating,
    navigation_type: event.navigationType,
  });
}

let started = false;

/**
 * Subscribe to the four core vitals and report each (once per page load).
 * Idempotent; lazy-imports web-vitals so its code only downloads after consent.
 * `report` is injectable for tests; defaults to the GA/PostHog sink.
 */
export async function startWebVitals(
  report: (event: VitalEvent) => void = sendVital,
): Promise<void> {
  if (started || typeof window === "undefined") return;
  started = true;

  const { onLCP, onINP, onCLS, onTTFB } = await import("web-vitals");
  // Re-check the environment AFTER the async import: web-vitals' onLCP/onINP/etc.
  // touch `document` synchronously, and the environment can disappear between the
  // await and here (jsdom teardown in unit tests → an unhandled `document is not
  // defined` rejection; also SSR safety). No effect in a real browser.
  if (typeof document === "undefined") return;
  const handler = (metric: Metric) => report(buildVitalEvent(metric));
  onLCP(handler);
  onINP(handler);
  onCLS(handler);
  onTTFB(handler);
}

/** Test-only reset of the once-guard. */
export function __resetWebVitalsForTest(): void {
  started = false;
}
