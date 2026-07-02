// Location-aware consent regime (privacy epic). Maps the coarse geo signal from
// /geo.json (functions/geo.json.ts) to the consent model the cookie banner uses:
//
//   opt-in  — GDPR / UK-GDPR / ePrivacy, and everywhere we're unsure. No
//             non-essential cookies until the visitor actively consents;
//             granular categories; "Reject all" as easy as "Accept all".
//   opt-out — United States (CCPA/CPRA + ~20 state laws). Non-essential cookies
//             may run by default; we honor Global Privacy Control and surface a
//             "Your Privacy Choices" affordance.
//
// Failing safe: we DEFAULT to opt-in and lighten to opt-out only for countries
// we positively resolve to a US-style regime. An unknown/unresolved country
// (VPN, Tor, edge failure) therefore gets the stricter opt-in banner.

export type ConsentRegime = "opt-in" | "opt-out";

export interface GeoSignal {
  /** ISO 3166-1 alpha-2, uppercased, or null if unknown. */
  country: string | null;
  /** Subdivision code where known (e.g. "CA" for California), else null. */
  regionCode: string | null;
  /** True when the country is inside the EU. */
  isEU: boolean;
}

/** Used whenever geo is unknown → drives the strict (opt-in) default. */
export const UNKNOWN_GEO: GeoSignal = {
  country: null,
  regionCode: null,
  isEU: false,
};

// Countries whose privacy law is opt-out (notice + right to opt out) rather than
// prior opt-in. A set so adding another opt-out jurisdiction is a one-line change.
const OPT_OUT_COUNTRIES = new Set<string>(["US"]);

export function regimeForGeo(geo: GeoSignal | null): ConsentRegime {
  if (!geo || !geo.country) return "opt-in"; // unknown → fail safe (strict)
  return OPT_OUT_COUNTRIES.has(geo.country) ? "opt-out" : "opt-in";
}

// Whether to surface the CCPA "Your Privacy Choices" link. Shown for the whole
// US opt-out regime (not just California) since ~20 states now grant equivalent
// opt-out rights.
export function showsPrivacyChoices(geo: GeoSignal | null): boolean {
  return regimeForGeo(geo) === "opt-out";
}

/**
 * Global Privacy Control — a browser/extension signal that legally counts as a
 * universal opt-out in ~12 US states. Read synchronously; absent on most setups.
 */
export function isGpcEnabled(): boolean {
  try {
    return (
      (navigator as unknown as { globalPrivacyControl?: boolean })
        .globalPrivacyControl === true
    );
  } catch {
    return false;
  }
}

const GEO_ENDPOINT = "/geo.json";
const GEO_SESSION_KEY = "gt_geo";

// undefined = never fetched; null = fetched but unknown/failed; object = known.
let cached: GeoSignal | null | undefined;

/** Synchronous cache read: object | null (known-unknown) | undefined (unfetched). */
export function getCachedGeo(): GeoSignal | null | undefined {
  if (cached !== undefined) return cached;
  try {
    const raw = sessionStorage.getItem(GEO_SESSION_KEY);
    if (raw) {
      cached = JSON.parse(raw) as GeoSignal;
      return cached;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Fetch the geo signal once per session; resolves to UNKNOWN_GEO on any error. */
export async function fetchGeo(): Promise<GeoSignal> {
  const existing = getCachedGeo();
  if (existing !== undefined) return existing ?? UNKNOWN_GEO;
  try {
    const res = await fetch(GEO_ENDPOINT, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`geo ${res.status}`);
    const geo = (await res.json()) as GeoSignal;
    cached = geo;
    try {
      sessionStorage.setItem(GEO_SESSION_KEY, JSON.stringify(geo));
    } catch {
      /* ignore */
    }
    return geo;
  } catch {
    cached = null; // remember the failure so we don't refetch every render
    return UNKNOWN_GEO;
  }
}

// Test-only: reset the module cache between unit tests.
export function __resetGeoCacheForTests() {
  cached = undefined;
}
