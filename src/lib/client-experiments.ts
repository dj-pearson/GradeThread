// US-2109: client-side A/B experiments backed by PostHog feature flags.
//
// This is a CONNECTOR, not a second flag framework. It deliberately does not
// bucket, roll out, or target — PostHog already does all three, and the
// server-side engine (services/edge-functions/src/lib/feature-flags.ts) does it
// for the surfaces it owns. See vault/40-growth/experimentation.md for which
// system owns what and why they must not be pointed at the same decision.
//
// ── The three properties that make results trustworthy ──────────────────────
//
// 1. CONSENT. Flags are read off window.posthog, which only exists after the
//    visitor opts into the analytics category (analytics.ts startAnalyticsTools).
//    Before that there is nothing to ask, so an unconsented visitor cannot be
//    bucketed or exposed — the gate is structural, not a check someone can
//    forget to write. They see the control.
//
// 2. NO MID-SESSION FLIPS. A resolved variant is LOCKED in memory for the page
//    session. PostHog can re-deliver flags (on identify, on reload of the flag
//    payload), and a paywall whose copy changes while the visitor is reading it
//    is both a bad experience and a corrupted data point — that person saw both
//    arms, so their conversion belongs to neither.
//
// 3. EXPOSURE IS AN EVENT, NOT AN EVALUATION. `$feature_flag_called` fires when
//    code ASKS about a flag, which happens on mount, in effects, sometimes on
//    pages the visitor never scrolled to. This module fires an explicit
//    `experiment_exposed` only when a caller says the variant was actually
//    SHOWN, and at most once per flag per session. Analysing on evaluation
//    rather than exposure is the classic way to dilute a real effect into
//    nothing.

import { track } from "./analytics";

/** Resolved assignment for one experiment. */
export interface ExperimentAssignment {
  /** The variant to render. `control` whenever we cannot know better. */
  variant: string;
  /**
   * Whether PostHog has actually delivered flags yet.
   *
   * Callers rendering a conversion surface should hold exposure (and any
   * variant-dependent copy) until this is true — otherwise the visitor is
   * counted as exposed to `control` and then shown the variant.
   */
  ready: boolean;
}

export const CONTROL = "control";

// Locked assignments: flag key → variant. Survives re-renders and re-deliveries
// for the life of the page (property 2 above).
const locked = new Map<string, string>();
// Flags we have already reported an exposure for (property 3).
const exposed = new Set<string>();

/** Test seam: clears per-session experiment state. */
export function __resetExperimentsForTest() {
  locked.clear();
  exposed.clear();
}

/**
 * Read a flag's variant, normalizing PostHog's three return shapes:
 *   string    → a multivariate variant name, used as-is
 *   true      → a boolean flag that is ON; expressed as the "test" variant so
 *               callers only ever branch on variant names, never on two types
 *   false     → OFF, i.e. control
 *   undefined → flags not delivered yet (or no consent) — NOT control, because
 *               "we don't know" and "we know it's control" must stay separable;
 *               conflating them is what produces phantom control exposures.
 */
function readVariant(key: string): string | undefined {
  try {
    const raw = window.posthog?.getFeatureFlag?.(key);
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === "boolean") return raw ? "test" : CONTROL;
    return String(raw) || CONTROL;
  } catch {
    // Analytics must never break the UI. An unreadable flag is not-yet-known,
    // so the caller keeps showing the control.
    return undefined;
  }
}

/**
 * The current assignment for `key`, locking it on first resolution.
 *
 * Pure with respect to React — the hook wraps this. Safe to call in SSR/prerender
 * (no window → control, not ready).
 */
export function getAssignment(key: string): ExperimentAssignment {
  const already = locked.get(key);
  if (already !== undefined) return { variant: already, ready: true };

  if (typeof window === "undefined") return { variant: CONTROL, ready: false };

  const variant = readVariant(key);
  if (variant === undefined) return { variant: CONTROL, ready: false };

  locked.set(key, variant);
  return { variant, ready: true };
}

/**
 * Report that the visitor actually SAW `variant` of `key`. Idempotent per flag
 * per session, so a component that mounts twice does not double-count.
 *
 * No-ops before flags resolve: an exposure recorded against a placeholder
 * control would be a fabricated data point, and it would land in the arm the
 * visitor was NOT in.
 */
export function trackExposure(key: string, variant: string): void {
  if (exposed.has(key)) return;
  if (!locked.has(key)) return;
  exposed.add(key);
  track("experiment_exposed", {
    experiment: key,
    variant,
    // Namespaced so these are trivially separable from product events when
    // building an analysis cohort.
    $feature_flag: key,
    $feature_flag_response: variant,
  });
}

/**
 * Subscribe to PostHog's flag delivery. Returns an unsubscribe function.
 *
 * PostHog loads flags asynchronously after init, so a component mounted before
 * delivery would otherwise sit on `control` forever with no re-render.
 */
export function onFlagsReady(cb: () => void): () => void {
  try {
    const off = window.posthog?.onFeatureFlags?.(cb);
    if (typeof off === "function") return off;
  } catch {
    /* analytics must never break the UI */
  }
  return () => {};
}
