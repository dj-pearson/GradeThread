// US-2997 — auth for /api/flipdesk/qbo/* is DENY BY DEFAULT.
//
// Same shape as ebay-auth.ts, and for the same reason: naming individual paths
// in main.ts means a route added later falls outside the list and ships with no
// auth at all, with nothing saying so. One mount, and the only way out is the
// explicit skip-list below.
//
// Adding an entry here is a SECURITY DECISION, not a way to quiet a test. State
// the mechanism that replaces the session.

import { createMiddleware } from "hono/factory";
import { authMiddleware } from "./auth.ts";

const QBO_PREFIX = "/api/flipdesk/qbo";

export const QBO_SELF_AUTHENTICATING: ReadonlyMap<string, string> = new Map([
  [
    "/oauth/callback",
    "Intuit redirects the browser here; there is no session yet. Verified by " +
      "the single-use `state` row minted at /oauth/start and deleted-and-" +
      "returned in one statement, which is the standard OAuth CSRF defence.",
  ],
  ["/oauth/refresh", "requireJobSecret (X-Internal-Job-Secret) — Coolify cron."],
]);

/**
 * Exact match only, deliberately not a prefix test: a prefix match would hand
 * any future `/oauth/callback/...` route the exemption meant for one path.
 * A trailing slash is tolerated because that is a request shape, not a route.
 */
export function isQboSelfAuthenticating(path: string): boolean {
  if (!path.startsWith(QBO_PREFIX)) return false;
  const rest = path.slice(QBO_PREFIX.length).replace(/\/$/, "");
  return QBO_SELF_AUTHENTICATING.has(rest);
}

export const qboAuthMiddleware = createMiddleware(async (c, next) => {
  if (isQboSelfAuthenticating(c.req.path)) {
    await next();
    return;
  }
  return await authMiddleware(c, next);
});
