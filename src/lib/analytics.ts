// Consent-gated analytics (GDPR/CCPA), per-category (privacy epic).
//
// Google Analytics is bootstrapped in index.html with Consent Mode v2 defaulting
// EVERY signal to "denied"; PostHog + web-vitals are not loaded at all until the
// visitor opts into the "analytics" category. Consent is stored per category so
// the banner can offer granular EU-style choices:
//
//   necessary — always on (auth/session/consent itself); never stored, never
//               offered as a toggle. Not represented here.
//   analytics — GA analytics_storage + PostHog product analytics + Core Web
//               Vitals.
//   marketing — GA ad_storage / ad_user_data / ad_personalization (Google Ads
//               + remarketing).
//
// Sentry (error monitoring) is intentionally NOT gated here: after the US-privacy
// hardening it sends no PII/IP (see src/lib/sentry.ts), so it runs under
// legitimate interest for security + reliability, which does not require consent.

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    posthog?: {
      capture?: (e: string, p?: Record<string, unknown>) => void;
      opt_in_capturing?: () => void;
      opt_out_capturing?: () => void;
    };
  }
}

const CONSENT_KEY = "gt_cookie_consent";

export interface ConsentState {
  analytics: boolean;
  marketing: boolean;
}

export const GRANT_ALL: ConsentState = { analytics: true, marketing: true };
export const DENY_ALL: ConsentState = { analytics: false, marketing: false };

/**
 * The visitor's stored per-category choice, or null if they haven't decided.
 * Migrates the pre-per-category binary values ("granted"/"denied") so returning
 * visitors keep their prior choice without a re-prompt.
 */
export function getConsent(): ConsentState | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (!v) return null;
    if (v === "granted") return { ...GRANT_ALL }; // legacy binary
    if (v === "denied") return { ...DENY_ALL }; //  legacy binary
    const parsed = JSON.parse(v) as Partial<ConsentState>;
    return {
      analytics: parsed.analytics === true,
      marketing: parsed.marketing === true,
    };
  } catch {
    return null;
  }
}

/** Whether the visitor has made any cookie choice yet (drives banner visibility). */
export function hasConsentDecision(): boolean {
  return getConsent() !== null;
}

function persist(state: ConsentState) {
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(state));
  } catch {
    /* private mode / storage disabled — choice just won't persist */
  }
}

// Reflect a consent state into Google Consent Mode. GA replays these against the
// denied-by-default signals set in index.html.
function applyGtagConsent(state: ConsentState) {
  window.gtag?.("consent", "update", {
    analytics_storage: state.analytics ? "granted" : "denied",
    ad_storage: state.marketing ? "granted" : "denied",
    ad_user_data: state.marketing ? "granted" : "denied",
    ad_personalization: state.marketing ? "granted" : "denied",
  });
}

let posthogStarted = false;

// Lazy-load PostHog + Core Web Vitals — their chunks only download once the
// visitor has opted into analytics. Safe to call repeatedly.
async function startAnalyticsTools() {
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
  } else if (posthogStarted) {
    // Re-opt-in if the visitor previously withdrew then re-granted this session.
    try {
      window.posthog?.opt_in_capturing?.();
    } catch {
      /* never break on analytics */
    }
  }

  // Real-user Core Web Vitals (US-305) — lazy so it never downloads for visitors
  // who decline analytics.
  const { startWebVitals } = await import("./web-vitals");
  void startWebVitals();
}

/** Apply a consent state now (update Consent Mode, start/stop analytics tools). */
export async function applyConsent(state: ConsentState) {
  applyGtagConsent(state);
  if (state.analytics) {
    await startAnalyticsTools();
  } else if (posthogStarted) {
    // Withdrawn after being granted earlier this session — stop capturing.
    try {
      window.posthog?.opt_out_capturing?.();
    } catch {
      /* never break on analytics */
    }
  }
}

/** Persist a per-category choice and apply it immediately. */
export function saveConsent(state: ConsentState) {
  persist(state);
  void applyConsent(state);
}

/** Convenience: opt into everything (banner "Accept all"). */
export function acceptAll() {
  saveConsent({ ...GRANT_ALL });
}

/** Convenience: opt out of everything non-essential (banner "Reject all"). */
export function rejectAll() {
  saveConsent({ ...DENY_ALL });
}

// Called once on app startup: returning visitors who already chose get their
// prior consent re-applied without a re-prompt.
export function initAnalyticsFromStoredConsent() {
  const stored = getConsent();
  if (stored) void applyConsent(stored);
}

// ── Product event tracking ──────────────────────────────────────
//
// Thin, consent-safe wrapper over PostHog's capture(). posthog-js attaches
// itself to window.posthog once analytics consent initializes it; before consent
// (or in DEV, where capturing is opted out) this is a silent no-op. Never let
// analytics throw into product code.
export function track(event: string, props?: Record<string, unknown>): void {
  try {
    window.posthog?.capture?.(event, props);
  } catch {
    /* analytics must never break the UI */
  }
}
