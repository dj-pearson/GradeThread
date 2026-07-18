// US-2014 — every /api/flipdesk/ebay route must be authenticated OR explicitly
// declared public.
//
// THE PROBLEM THIS SOLVES. Auth for this module is an ALLOWLIST: main.ts names
// ~33 individual path patterns, while most other modules use a single `/*`
// wildcard. flipdesk-ebay.ts is ~7900 lines with 81 routes. Adding one route
// whose path falls outside the allowlist ships it with NO auth middleware and
// NO test failure — the default is open, and nothing says so.
//
// The failure has already happened once in the SAFE direction: US-1623 records
// five sub-paths that were missing from the allowlist, so authMiddleware never
// ran and the handlers (which read workspaceOwnerId ?? userId) failed closed to
// 401 for legitimately signed-in sellers. That was a visible outage. The same
// omission on a route that does NOT depend on a caller id fails the other way,
// silently.
//
// WHY A GUARD RATHER THAN INVERTING THE MIDDLEWARE. The obvious fix is
// `app.use("/api/flipdesk/ebay/*", authMiddleware)` plus a skip-list. That is
// probably the right end state, but it re-wires auth for 81 live routes
// including OAuth callbacks and five cron endpoints, and it cannot be verified
// from here — getting the skip-list wrong 401s every Coolify cron and the eBay
// OAuth return, in production, silently until someone reconnects an account.
// This guard delivers the property the inversion is FOR (a new unauthenticated
// route cannot ship unnoticed) at zero deployment risk. The inversion remains
// worth doing behind a staging deploy; it is not worth doing blind.

import { assert } from "@std/assert";

const MAIN = await Deno.readTextFile(new URL("../main.ts", import.meta.url));
const ROUTES = await Deno.readTextFile(
  new URL("../routes/flipdesk-ebay.ts", import.meta.url),
);

/**
 * Routes that are deliberately NOT behind authMiddleware because they
 * authenticate themselves. Each was verified by reading the handler.
 *
 * Adding to this list is a SECURITY DECISION: state the mechanism, don't just
 * silence the test.
 */
const SELF_AUTHENTICATING: ReadonlyMap<string, string> = new Map([
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

function allowlistPatterns(): string[] {
  return [
    ...MAIN.matchAll(
      /app\.use\(\s*"\/api\/flipdesk\/ebay([^"]*)"\s*,\s*authMiddleware/g,
    ),
  ].map((m) => m[1]!);
}

function declaredRoutes(): Array<{ method: string; path: string }> {
  return [
    ...ROUTES.matchAll(
      /flipdeskEbayRoutes\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g,
    ),
  ].map((m) => ({ method: m[1]!.toUpperCase(), path: m[2]! }));
}

function isCovered(path: string, patterns: string[]): boolean {
  return patterns.some((p) =>
    p.endsWith("/*") ? path.startsWith(p.slice(0, -1)) : path === p
  );
}

Deno.test("every eBay route is auth-covered or explicitly self-authenticating", () => {
  const patterns = allowlistPatterns();
  const routes = declaredRoutes();

  // Sanity: if either parse breaks, this guard silently passes forever.
  assert(patterns.length > 10, `parsed only ${patterns.length} auth patterns — regex broke`);
  assert(routes.length > 50, `parsed only ${routes.length} eBay routes — regex broke`);

  const uncovered = routes
    .filter((r) => !isCovered(r.path, patterns))
    .filter((r) => !SELF_AUTHENTICATING.has(r.path));

  assert(
    uncovered.length === 0,
    `These /api/flipdesk/ebay routes have NO authMiddleware and are not declared ` +
      `self-authenticating, so they are reachable UNAUTHENTICATED:\n` +
      uncovered.map((r) => `  ${r.method} ${r.path}`).join("\n") +
      `\n\nAuth here is an ALLOWLIST (main.ts, ~${patterns.length} path patterns), so a new ` +
      `route is OPEN by default. Either add its path to the allowlist in main.ts, ` +
      `or — if it authenticates itself (job secret / signature / OAuth state) — add ` +
      `it to SELF_AUTHENTICATING in this file WITH the mechanism named.`,
  );
});

Deno.test("every self-authenticating exemption still proves its mechanism", () => {
  // An exemption that stops being true is worse than no exemption: it is a
  // documented promise that the code no longer keeps. Re-verify each against
  // the handler rather than trusting the list.
  for (const [path, reason] of SELF_AUTHENTICATING) {
    const decl = new RegExp(
      `flipdeskEbayRoutes\\.(get|post|put|patch|delete)\\(\\s*"${path.replace(/\//g, "\\/")}"`,
    );
    const m = decl.exec(ROUTES);
    assert(
      m,
      `SELF_AUTHENTICATING lists ${path}, but no such route exists in ` +
        `flipdesk-ebay.ts. Remove the stale exemption — a list of imaginary ` +
        `routes trains the reader to skim it.`,
    );
    const body = ROUTES.slice(m!.index, m!.index + 900);
    const guarded = /requireJobSecret/.test(body) ||
      /c\.req\.query\("state"\)/.test(body);
    assert(
      guarded,
      `${path} is exempted from auth ("${reason}") but its handler no longer ` +
        `shows a self-auth mechanism (requireJobSecret or an OAuth state check) ` +
        `in its first 900 chars. If the mechanism moved, update this guard; if ` +
        `it was removed, the route is now genuinely unauthenticated.`,
    );
  }
});
