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
import { workspaceMiddleware } from "./workspace.ts";

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

/**
 * Workspace context for the QuickBooks module, skipping the two routes that
 * have no session.
 *
 * WHY THIS EXISTS AND IS NOT JUST `workspaceMiddleware`. That middleware 401s
 * with "Auth context missing" the moment `userId` is absent, and the two
 * self-authenticating routes are absent by definition: Intuit redirects a
 * browser to /oauth/callback carrying no session, and the cron calls
 * /oauth/refresh with a job secret and no user at all.
 *
 * Mounted as a wildcard, it therefore 401s the OAuth callback and the ENTIRE
 * connect flow can never complete -- the seller approves at Intuit, comes back,
 * and gets a bare 401. The hourly refresh sweep dies the same way, silently,
 * which is the exact failure AC6 exists to prevent.
 *
 * It reuses `isQboSelfAuthenticating` rather than repeating the path list, so
 * the two skip sets cannot drift: a route that stops needing auth stops needing
 * workspace context at the same moment, by construction.
 */
export const qboWorkspaceMiddleware = createMiddleware(async (c, next) => {
  if (isQboSelfAuthenticating(c.req.path)) {
    await next();
    return;
  }
  return await workspaceMiddleware(c, next);
});
