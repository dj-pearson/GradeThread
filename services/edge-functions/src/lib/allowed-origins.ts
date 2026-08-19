// First-party origin allowlist, shared by CORS in main.ts and by the MCP
// endpoint's DNS-rebinding guard (US-9103).
//
// Extracted from main.ts so there is exactly one definition of "an origin we
// trust". The MCP transport MUST reject an invalid Origin with 403 (a spec
// requirement and a named connector-review rejection cause), and a second copy
// of this list would drift the moment a brand domain changed.
//
// Nothing here imports a route, so importing it from main.ts is not circular.

import { isProduction } from "./env.ts";

// US-363: localhost is a dev-only origin and is dropped in production builds so
// a prod deploy never trusts a loopback origin. The remaining origins are
// first-party GradeThread / FlipDesk brand domains.
export const ALLOWED_ORIGINS = new Set<string>([
  "https://gradethread.com",
  "https://www.gradethread.com",
  "https://flipdesk.com",
  "https://www.flipdesk.com",
  ...(isProduction() ? [] : ["http://localhost:5173"]),
]);

// US-520: staging frontend + Cloudflare Pages PR-preview origins
// (https://<hash>.<project>.pages.dev). Honored ONLY off-production — the prod
// deploy (EDGE_ENV=production) never trusts a staging or preview origin.
export const STAGING_ORIGIN = "https://staging.gradethread.com";
export const PAGES_PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.gradethread\.pages\.dev$/;

// US-1754: the browser extension (US-1755) calls the public grade-from-url
// endpoint cross-origin. Its origin is chrome-extension://<id> /
// moz-extension://<id>, which can't be hardcoded because the id is assigned at
// store-publish time — so it is configured via EXTENSION_ALLOWED_ORIGINS
// (comma-separated). Empty ⇒ no extension origin is trusted (the public
// endpoints then remain same-origin / server-to-server only). CORS is not the
// security boundary here — the per-IP/per-instance quotas + the AI daily ceiling
// are — so trusting our own extension's origin globally is safe and simpler.
export const EXTENSION_ALLOWED_ORIGINS = new Set<string>(
  (Deno.env.get("EXTENSION_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (EXTENSION_ALLOWED_ORIGINS.has(origin)) return true;
  if (isProduction()) return false;
  return origin === STAGING_ORIGIN || PAGES_PREVIEW_ORIGIN_RE.test(origin);
}
