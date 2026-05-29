// Consent-gated analytics (GDPR/CCPA). Google Analytics is loaded in
// index.html with Consent Mode v2 defaulting to denied; PostHog is not loaded
// at all until the user opts in. Both are activated only by startAnalytics(),
// which the cookie-consent banner calls on "Accept". Sentry (error monitoring)
// is intentionally NOT gated here — it runs under legitimate interest and
// captures no marketing/advertising signals.

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

const CONSENT_KEY = "gt_cookie_consent";
export type ConsentChoice = "granted" | "denied";

export function getStoredConsent(): ConsentChoice | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

function storeConsent(choice: ConsentChoice) {
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    /* private mode / storage disabled — choice just won't persist */
  }
}

let posthogStarted = false;

// Activate analytics after consent: flip Google Consent Mode to granted and
// lazy-load PostHog (its ~170KB chunk only downloads once consent is given).
export async function startAnalytics() {
  window.gtag?.("consent", "update", {
    analytics_storage: "granted",
  });

  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (key && !posthogStarted) {
    posthogStarted = true;
    const { default: posthog } = await import("posthog-js");
    posthog.init(key, {
      api_host: import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com",
      loaded: (ph) => {
        if (import.meta.env.DEV) ph.opt_out_capturing();
      },
    });
  }

  // Real-user Core Web Vitals (US-305). Consent-gated by living here: it only
  // runs once the visitor has opted in. Lazy-imports the web-vitals library so
  // its code never downloads for visitors who decline.
  const { startWebVitals } = await import("./web-vitals");
  void startWebVitals();
}

export function acceptConsent() {
  storeConsent("granted");
  void startAnalytics();
}

export function declineConsent() {
  storeConsent("denied");
  // Google Consent Mode stays denied (its index.html default); PostHog never
  // initializes. Nothing to tear down.
}

// Called once on app startup: returning visitors who already opted in get
// analytics back without re-prompting.
export function initAnalyticsFromStoredConsent() {
  if (getStoredConsent() === "granted") {
    void startAnalytics();
  }
}
