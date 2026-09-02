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

// TYPE-ONLY, deliberately. The registry's `AnalyticsEvent` union is built partly
// from buyer-analytics.ts, which imports `track` from this file — a runtime
// import back would close a module cycle at boot. Type-only imports erase.
import type { AnalyticsEvent } from "./analytics-events";
import { redactSensitiveUrl } from "./redact-url";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    posthog?: {
      capture?: (e: string, p?: Record<string, unknown>) => void;
      opt_in_capturing?: () => void;
      opt_out_capturing?: () => void;
      // US-2109: client-side experiments. These exist only once analytics
      // consent has initialized posthog-js, which is exactly the consent gate —
      // there is no code path that can evaluate a flag earlier, because there is
      // no posthog to ask.
      getFeatureFlag?: (key: string) => string | boolean | undefined;
      onFeatureFlags?: (cb: () => void) => (() => void) | void;
    };
  }
}

const CONSENT_KEY = "gt_cookie_consent";

export interface ConsentState {
  analytics: boolean;
  marketing: boolean;
}

const GRANT_ALL: ConsentState = { analytics: true, marketing: true };
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

// ── AI-search referrer segmentation (US-1670) ───────────────────────
//
// Universe A (condition grading) is a demand-CREATION motion whose signups
// increasingly arrive from AI answer engines, not classic search. AI engines
// mostly send a normal HTTP referrer, so we classify document.referrer into a
// named engine and register it as a PostHog super-property (ai_referrer). That
// makes "signups whose first touch was an AI assistant" a one-filter segment —
// the only reliable referrer-side AI attribution available (the self-reported
// signup-source survey adds the rest). Pure + exported for unit tests.

/** referrer host (or host+path prefix) → engine name. */
const AI_ENGINE_HOSTS: Array<{ match: RegExp; engine: string }> = [
  { match: /(^|\.)chatgpt\.com$/i, engine: "chatgpt" },
  { match: /(^|\.)chat\.openai\.com$/i, engine: "chatgpt" },
  { match: /(^|\.)perplexity\.ai$/i, engine: "perplexity" },
  { match: /(^|\.)claude\.ai$/i, engine: "claude" },
  { match: /(^|\.)gemini\.google\.com$/i, engine: "gemini" },
  { match: /(^|\.)copilot\.microsoft\.com$/i, engine: "copilot" },
  { match: /(^|\.)you\.com$/i, engine: "you" },
  { match: /(^|\.)poe\.com$/i, engine: "poe" },
];

/** The AI engine that referred a visit, or null. Accepts a full referrer URL. */
export function classifyAiReferrer(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  let host: string;
  try {
    host = new URL(referrer).hostname;
  } catch {
    return null;
  }
  for (const { match, engine } of AI_ENGINE_HOSTS) {
    if (match.test(host)) return engine;
  }
  return null;
}

// Register the first-touch AI-referrer classification as PostHog super-properties
// so every subsequent event (incl. signup) carries it. Guarded so it never throws.
function registerAiReferrer(
  posthog: { register?: (p: Record<string, unknown>) => void },
) {
  try {
    const engine =
      typeof document !== "undefined"
        ? classifyAiReferrer(document.referrer)
        : null;
    posthog.register?.({
      ai_referrer: engine,
      ai_referred: engine !== null,
    });
  } catch {
    /* analytics must never break the UI */
  }
}

// Tag every event with the product that produced it. The portfolio shares ONE
// PostHog project (the free plan allows exactly one), so without this property a
// second product's events are indistinguishable from GradeThread's in every
// insight on the shared dashboard. Registered as a super-property so it rides
// events this module never touches, including autocapture and $pageview.
function registerProject(
  posthog: { register?: (p: Record<string, unknown>) => void },
) {
  try {
    posthog.register?.({ project: "gradethread" });
  } catch {
    /* analytics must never break the UI */
  }
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
      // US-1635: redact single-use auth tokens from any URL property before the
      // event is sent — an /auth/* pageview would otherwise ship a still-valid
      // token_hash to PostHog.
      sanitize_properties: (props: Record<string, unknown>) => {
        for (
          const k of [
            "$current_url",
            "$referrer",
            "$pathname",
            "$initial_current_url",
            "$initial_referrer",
          ]
        ) {
          const v = props[k];
          if (typeof v === "string") props[k] = redactSensitiveUrl(v);
        }
        return props;
      },
    });
    // Registered BEFORE any other super-property so the very first event of the
    // session already carries it.
    registerProject(posthog);
    // US-1670: tag the session with the AI engine (if any) that referred it.
    registerAiReferrer(posthog);
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
async function applyConsent(state: ConsentState) {
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
export function track(event: AnalyticsEvent, props?: Record<string, unknown>): void {
  try {
    window.posthog?.capture?.(event, props);
  } catch {
    /* analytics must never break the UI */
  }
}
