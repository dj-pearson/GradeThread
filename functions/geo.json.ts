// Visitor geo signal for location-aware cookie consent (privacy epic).
//
// Cloudflare tags every request with the client's country + an EU flag on
// `request.cf` at the edge — so we never call a third-party IP-geolocation
// service (which would itself be a privacy problem). This endpoint exposes only
// the coarse signals the consent banner needs to pick a regime:
//   - EU/EEA/UK/CH  → opt-IN (GDPR + ePrivacy): no non-essential cookies until
//                     the visitor consents; granular, reject-as-easy-as-accept.
//   - US            → opt-OUT (CCPA/CPRA + state laws): honor Global Privacy
//                     Control; surface "Your Privacy Choices".
// The regime mapping itself lives in src/lib/consent-regime.ts (pure + unit
// tested); this function only reports the raw geo so that logic is single-sourced
// on the client and not duplicated in the Pages-Functions runtime.
//
// Served at /geo.json (registered in public/_routes.json). NEVER cached at the
// CDN — the response is per-IP, so a shared cache entry would leak one visitor's
// country to another. The browser caches it for the session instead.

interface IncomingRequestCfProperties {
  country?: string | null;
  isEUCountry?: string | null;
  regionCode?: string | null;
  region?: string | null;
  continent?: string | null;
}

export interface GeoResponse {
  /** ISO 3166-1 alpha-2, uppercased (e.g. "US", "GB", "DE"), or null if unknown. */
  country: string | null;
  /** Subdivision code where known (e.g. "CA" for California), else null. */
  regionCode: string | null;
  /** True when Cloudflare marks the country as inside the EU. */
  isEU: boolean;
}

export const onRequestGet: PagesFunction = ({ request }) => {
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;

  const rawCountry = cf?.country ?? null;
  // Cloudflare uses "T1" (Tor) and "XX" for unknown/unresolvable — treat both as
  // unknown so the client falls back to the safe (opt-in) default.
  const country = rawCountry && rawCountry !== "T1" && rawCountry !== "XX"
    ? rawCountry.toUpperCase()
    : null;

  const body: GeoResponse = {
    country,
    regionCode: cf?.regionCode ?? null,
    isEU: cf?.isEUCountry === "1",
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Per-IP → must never be shared across visitors by the CDN.
      "Cache-Control": "private, no-store",
    },
  });
};
