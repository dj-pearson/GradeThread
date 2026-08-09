// US-2014 AC3 — auth for /api/flipdesk/ebay/* is DENY BY DEFAULT.
//
// WHAT CHANGED AND WHY. main.ts used to name ~35 individual eBay path patterns,
// each one an app.use(..., authMiddleware). flipdesk-ebay.ts declares 80+ routes,
// so a route whose path fell outside those 35 patterns shipped with no auth
// middleware at all. The default was OPEN, and nothing in main.ts said so.
//
// That omission has already happened five times in the SAFE direction (US-1623:
// the handlers read workspaceOwnerId ?? userId, so an unauthenticated request
// failed closed to 401 for legitimately signed-in sellers — a visible outage).
// The same omission on a route that does not depend on a caller id fails the
// other way, silently.
//
// Now there is ONE mount — app.use("/api/flipdesk/ebay/*", ebayAuthMiddleware) —
// and the only way out is this file's explicit skip-list. A new route is closed
// unless somebody writes down why it is open.
//
// SAFETY OF THE INVERSION. It can only ADD auth, never remove it: every path the
// old allowlist covered is a subset of /api/flipdesk/ebay/*. The routes whose
// behaviour changes are exactly the ones the old allowlist missed, and
// ebay-auth-coverage_test.ts proved that set was precisely the six paths below.

import { createMiddleware } from "hono/factory";
import { authMiddleware } from "./auth.ts";

const EBAY_PREFIX = "/api/flipdesk/ebay";

/**
 * Paths under /api/flipdesk/ebay that deliberately run WITHOUT authMiddleware
 * because they authenticate themselves. Keys are relative to {@link EBAY_PREFIX},
 * matching how the routes are declared in routes/flipdesk-ebay.ts.
 *
 * Adding an entry here is a SECURITY DECISION, not a way to quiet a test: state
 * the mechanism. ebay-auth-coverage_test.ts re-reads each handler and fails if
 * the named mechanism is no longer visible in it.
 */
export const EBAY_SELF_AUTHENTICATING: ReadonlyMap<string, string> = new Map([
  [
    "/oauth/callback",
    "eBay redirects the browser here; there is no session yet. Verified by the " +
      "single-use `state` token minted at /oauth/start, which is the standard " +
      "OAuth CSRF defence — an attacker cannot forge it.",
  ],
  ["/oauth/refresh", "requireJobSecret (X-Internal-Job-Secret) — Coolify cron."],
  ["/sync/performance", "requireJobSecret — Coolify cron."],
  ["/jobs/leave-feedback", "requireJobSecret — Coolify cron."],
  ["/jobs/publish-due", "requireJobSecret — Coolify cron."],
  ["/jobs/promoted-sync", "requireJobSecret — Coolify cron."],
]);

/**
 * True when `path` (a full request path, e.g. "/api/flipdesk/ebay/oauth/callback")
 * is one of the declared self-authenticating routes.
 *
 * Exact match only — deliberately NOT a prefix test. `/sync/performance` is a
 * job-secret cron while its sibling `/sync/performance/me` is a signed-in
 * seller's "Sync now"; a prefix match would hand the seller route to the cron
 * exemption and ship it unauthenticated. A trailing slash is tolerated because
 * that is a request-shape difference, not a different route.
 */
export function isEbaySelfAuthenticating(path: string): boolean {
  if (!path.startsWith(EBAY_PREFIX)) return false;
  const rest = path.slice(EBAY_PREFIX.length).replace(/\/$/, "");
  return EBAY_SELF_AUTHENTICATING.has(rest);
}

/**
 * Deny-by-default auth for the eBay module: run authMiddleware unless the path
 * is on the skip-list above.
 */
export const ebayAuthMiddleware = createMiddleware(async (c, next) => {
  if (isEbaySelfAuthenticating(c.req.path)) {
    await next();
    return;
  }
  return await authMiddleware(c, next);
});
