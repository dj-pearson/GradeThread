import { getConsent } from "./analytics";
// US-1700: client-side ad click-id capture.
//
// On an inbound visit we read Google's click ids (gclid / gbraid / wbraid) from
// the URL query, store the first-party (localStorage) with a timestamp, and — once
// the visitor authenticates — POST it to /api/ads/attribution so the click links
// to the converting user. Click ids are opaque identifiers, NOT PII, and never
// leave first-party storage except that one authenticated call.

const STORAGE_KEY = "gt_ad_attribution";
const MAX_CLICK_ID_LEN = 512;

/** URL params we capture → the ad platform they belong to. */
export const CLICK_ID_PARAMS: Record<string, string> = {
  gclid: "google_ads",
  gbraid: "google_ads",
  wbraid: "google_ads",
};

export interface StoredAttribution {
  clickId: string;
  clickIdType: string;
  platform: string;
  landingAt: string;
  /** True once it's been POSTed to the server for the signed-in user. */
  persisted: boolean;
}

function readStore(): StoredAttribution | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredAttribution>;
    if (typeof v.clickId === "string" && typeof v.clickIdType === "string" && typeof v.platform === "string") {
      return {
        clickId: v.clickId,
        clickIdType: v.clickIdType,
        platform: v.platform,
        landingAt: typeof v.landingAt === "string" ? v.landingAt : "",
        persisted: v.persisted === true,
      };
    }
  } catch { /* corrupt / unavailable */ }
  return null;
}

function writeStore(a: StoredAttribution): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  } catch { /* storage unavailable (private mode / SSR) */ }
}

export function getStoredAttribution(): StoredAttribution | null {
  return readStore();
}

export function markAttributionPersisted(): void {
  const a = readStore();
  if (a && !a.persisted) writeStore({ ...a, persisted: true });
}

/** Normalize a raw click id — trim + length-bound; null when empty/oversized. */
export function normalizeClickId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > MAX_CLICK_ID_LEN) return null;
  return v;
}

/**
 * Capture a click id from the URL query into first-party storage. A fresh click
 * id (new landing) replaces any stored one and resets `persisted`. Returns the
 * current stored attribution (existing one when no new click id is present).
 * `search` is injectable for testing; defaults to the live location.
 */
export function captureClickIds(
  search: string = typeof window !== "undefined" ? window.location.search : "",
  nowIso: string = new Date().toISOString(),
): StoredAttribution | null {
  const params = new URLSearchParams(search);
  for (const [param, platform] of Object.entries(CLICK_ID_PARAMS)) {
    const clickId = normalizeClickId(params.get(param));
    if (clickId) {
      const attr: StoredAttribution = {
        clickId,
        clickIdType: param,
        platform,
        landingAt: nowIso,
        persisted: false,
      };
      writeStore(attr);
      return attr;
    }
  }
  return readStore();
}

// ── US-2101: UTM channel attribution ─────────────────────────────────
//
// Click ids made PAID Google traffic attributable. Everything else — organic,
// email, social, and the entire SEO/content investment — was not: we WRITE utm
// tags into our own outbound links (the trial drip tags
// utm_source=drip&utm_campaign=trial_conversion) and then discard them the
// moment the visitor arrives. Without this there is no way to measure whether
// any of the content work landed.
//
// Kept in a SEPARATE store from click ids on purpose. A click id is one ad
// click; UTMs describe a channel and need first- AND last-touch, which are
// different lifetimes. Overloading StoredAttribution would have forced one
// eviction policy onto both.

const UTM_STORAGE_KEY = "gt_utm_attribution";
const MAX_UTM_LEN = 256;

/** The five standard UTM params, in the canonical order. */
export const UTM_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

export type UtmParam = (typeof UTM_PARAMS)[number];
export type UtmSet = Partial<Record<UtmParam, string>> & { landingAt: string };

export interface StoredUtm {
  /** The channel that ORIGINALLY brought this visitor. Never overwritten. */
  first: UtmSet;
  /** The most recent tagged visit. Overwritten on every new tagged landing. */
  last: UtmSet;
  persisted: boolean;
}

/**
 * US-2101 AC4: may we store channel attribution for this visitor?
 *
 * Reads the SAME consent record the analytics loader uses, so there is one
 * source of truth rather than a second, quietly divergent notion of consent.
 * Fails CLOSED: no decision yet means NO capture, because the banner exists
 * precisely to stop data being kept before the visitor has answered.
 */
function utmCaptureAllowed(): boolean {
  return getConsent()?.analytics === true;
}

/** Trim + length-bound a UTM value; null when empty or oversized. */
export function normalizeUtm(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > MAX_UTM_LEN) return null;
  return v;
}

function readUtmStore(): StoredUtm | null {
  try {
    const raw = localStorage.getItem(UTM_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredUtm>;
    if (!v.first || !v.last) return null;
    return { first: v.first, last: v.last, persisted: v.persisted === true };
  } catch {
    return null;
  }
}

function writeUtmStore(v: StoredUtm): void {
  try {
    localStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable (private mode / SSR) */
  }
}

export function getStoredUtm(): StoredUtm | null {
  return readUtmStore();
}

export function markUtmPersisted(): void {
  const v = readUtmStore();
  if (v && !v.persisted) writeUtmStore({ ...v, persisted: true });
}

/** Extract the UTM params present in a query string. Empty when none are. */
export function parseUtms(search: string, nowIso: string): UtmSet | null {
  const params = new URLSearchParams(search);
  const out: UtmSet = { landingAt: nowIso };
  let found = false;
  for (const key of UTM_PARAMS) {
    const v = normalizeUtm(params.get(key));
    if (v) {
      out[key] = v;
      found = true;
    }
  }
  return found ? out : null;
}

/**
 * Capture UTMs from the URL into first-party storage.
 *
 * AC4 — CONSENT GATED. Nothing is written before the visitor has opted into
 * analytics, matching how analytics.ts defers PostHog. This is the one rule
 * here that is not a preference: persisting channel data from someone who has
 * declined is the thing the consent banner exists to prevent, so it fails
 * CLOSED — no decision yet also means no write.
 *
 * AC3 — survives the OAuth/PKCE round trip and cross-page navigation for free,
 * because localStorage is origin-scoped and the round trip returns to the same
 * origin. That is why this is not held in memory or in the URL.
 */
export function captureUtms(
  search: string = typeof window !== "undefined" ? window.location.search : "",
  nowIso: string = new Date().toISOString(),
  allowed: boolean = utmCaptureAllowed(),
): StoredUtm | null {
  if (!allowed) return null;
  const incoming = parseUtms(search, nowIso);
  const existing = readUtmStore();
  if (!incoming) return existing;

  const next: StoredUtm = existing
    ? // First touch is the whole point of first touch: never overwritten.
      { first: existing.first, last: incoming, persisted: false }
    : { first: incoming, last: incoming, persisted: false };
  writeUtmStore(next);
  return next;
}
