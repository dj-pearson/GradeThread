// US-2014 AC3 — every /api/flipdesk/ebay route must be authenticated OR
// explicitly declared self-authenticating.
//
// WHAT THIS GUARDS NOW. main.ts used to name ~35 individual eBay path patterns.
// This suite existed to catch routes that fell outside them, because the default
// was OPEN. As of AC3 the default is CLOSED: one
// app.use("/api/flipdesk/ebay/*", ebayAuthMiddleware) covers the whole prefix and
// the only exit is EBAY_SELF_AUTHENTICATING in middleware/ebay-auth.ts.
//
// So the guard's job changed. It no longer hunts for gaps in an allowlist; it
// pins the three things the inversion depends on:
//   1. the single deny-by-default mount is still the mount (nobody re-introduced
//      per-path allowlisting, which would restore the open default);
//   2. the skip-list exempts EXACTLY the six routes it claims and nothing else,
//      checked against every route flipdesk-ebay.ts actually declares;
//   3. each exemption's stated mechanism is still visible in its handler.
// Plus a behavioural pass: the middleware really 401s an unauthenticated request
// to a normal route and really lets a skip-listed one through. The old version
// of this file asserted on source text only, so a middleware that matched paths
// wrongly would have passed it.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import {
  EBAY_SELF_AUTHENTICATING,
  ebayAuthMiddleware,
  isEbaySelfAuthenticating,
} from "../middleware/ebay-auth.ts";

const MAIN = await Deno.readTextFile(new URL("../main.ts", import.meta.url));
const ROUTES = await Deno.readTextFile(
  new URL("../routes/flipdesk-ebay.ts", import.meta.url),
);

const EBAY_PREFIX = "/api/flipdesk/ebay";

function declaredRoutes(): Array<{ method: string; path: string }> {
  return [
    ...ROUTES.matchAll(
      /flipdeskEbayRoutes\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g,
    ),
  ].map((m) => ({ method: m[1]!.toUpperCase(), path: m[2]! }));
}

Deno.test("the eBay prefix has ONE deny-by-default auth mount", () => {
  const mounts = [
    ...MAIN.matchAll(
      /app\.use\(\s*"(\/api\/flipdesk\/ebay[^"]*)"\s*,\s*(authMiddleware|ebayAuthMiddleware)\s*\)/g,
    ),
  ].map((m) => ({ path: m[1]!, mw: m[2]! }));

  assertEquals(
    mounts,
    [{ path: "/api/flipdesk/ebay/*", mw: "ebayAuthMiddleware" }],
    "Auth for the eBay module must stay a single wildcard mount with a skip-list " +
      "(US-2014 AC3). A per-path app.use(..., authMiddleware) here restores the " +
      "open-by-default allowlist the inversion removed: any route not named would " +
      "ship unauthenticated with no test failure. Put the exemption in " +
      "EBAY_SELF_AUTHENTICATING instead, with its mechanism.",
  );
});

Deno.test("the skip-list exempts exactly the declared self-authenticating routes", () => {
  const routes = declaredRoutes();

  // Sanity: if the parse breaks, this guard silently passes forever.
  assert(routes.length > 50, `parsed only ${routes.length} eBay routes — regex broke`);

  const exempt = routes
    .filter((r) => isEbaySelfAuthenticating(EBAY_PREFIX + r.path))
    .map((r) => r.path);

  assertEquals(
    [...new Set(exempt)].sort(),
    [...EBAY_SELF_AUTHENTICATING.keys()].sort(),
    "The set of eBay routes that skip authMiddleware must equal the skip-list " +
      "exactly. A route here that is not in EBAY_SELF_AUTHENTICATING is reachable " +
      "UNAUTHENTICATED; a key there that matches no route is a stale exemption.",
  );
});

Deno.test("a skip-list key that matches no route is rejected", () => {
  const declared = new Set(declaredRoutes().map((r) => r.path));
  for (const path of EBAY_SELF_AUTHENTICATING.keys()) {
    assert(
      declared.has(path),
      `EBAY_SELF_AUTHENTICATING lists ${path}, but no such route exists in ` +
        `flipdesk-ebay.ts. Remove the stale exemption — a list of imaginary ` +
        `routes trains the reader to skim it.`,
    );
  }
});

Deno.test("every self-authenticating exemption still proves its mechanism", () => {
  // An exemption that stops being true is worse than no exemption: it is a
  // documented promise that the code no longer keeps. Re-verify each against
  // the handler rather than trusting the list.
  for (const [path, reason] of EBAY_SELF_AUTHENTICATING) {
    const decl = new RegExp(
      `flipdeskEbayRoutes\\.(get|post|put|patch|delete)\\(\\s*"${path.replace(/\//g, "\\/")}"`,
    );
    const m = decl.exec(ROUTES);
    assert(m, `no route declaration found for exempted path ${path}`);
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

Deno.test("every job-secret route is on the skip-list", () => {
  // THE INVERSION'S ONE REAL RISK, guarded. The tests above all police the
  // dangerous direction (a route that should be authed but is not). This
  // polices the other one: a new cron whose handler gates on requireJobSecret
  // but whose path nobody added to the skip-list now gets authMiddleware, and
  // Coolify's cron sends a job secret, not a JWT — so it 401s on every fire,
  // forever, with no test failure and no user to complain. That is precisely
  // the outcome the earlier pass cited when it deferred this inversion.
  const decls = [
    ...ROUTES.matchAll(
      /flipdeskEbayRoutes\.(?:get|post|put|patch|delete)\(\s*"([^"]+)"/g,
    ),
  ];
  assert(decls.length > 50, `parsed only ${decls.length} eBay routes — regex broke`);

  const jobSecretRoutes: string[] = [];
  for (let i = 0; i < decls.length; i++) {
    const start = decls[i]!.index!;
    const end = i + 1 < decls.length ? decls[i + 1]!.index! : ROUTES.length;
    if (/requireJobSecret/.test(ROUTES.slice(start, end))) {
      jobSecretRoutes.push(decls[i]![1]!);
    }
  }
  assert(jobSecretRoutes.length > 0, "expected at least one requireJobSecret route");

  const missing = jobSecretRoutes.filter(
    (p) => !isEbaySelfAuthenticating(EBAY_PREFIX + p),
  );
  assertEquals(
    missing,
    [],
    `These eBay routes authenticate with a job secret but are NOT on the ` +
      `skip-list, so ebayAuthMiddleware will demand a JWT the cron does not ` +
      `have and every fire will 401 silently. Add each to ` +
      `EBAY_SELF_AUTHENTICATING with its mechanism.`,
  );
});

Deno.test("a sibling of a skip-listed path is NOT exempt", () => {
  // /sync/performance is a job-secret cron; /sync/performance/me is a signed-in
  // seller's "Sync now" (US-2233). A prefix match instead of an exact one would
  // hand the seller route the cron's exemption and ship it unauthenticated.
  assert(isEbaySelfAuthenticating(`${EBAY_PREFIX}/sync/performance`));
  assert(!isEbaySelfAuthenticating(`${EBAY_PREFIX}/sync/performance/me`));
  assert(!isEbaySelfAuthenticating(`${EBAY_PREFIX}/oauth/start`));
  assert(!isEbaySelfAuthenticating(`${EBAY_PREFIX}/jobs/anything-new`));
  // A path outside the module can never be exempted by this middleware.
  assert(!isEbaySelfAuthenticating("/api/flipdesk/etsy/oauth/callback"));
});

Deno.test("the middleware 401s a normal route and passes a skip-listed one", async () => {
  const app = new Hono();
  app.use("/api/flipdesk/ebay/*", ebayAuthMiddleware);
  app.all("/api/flipdesk/ebay/*", (c) => c.json({ reached: true }));

  // No Authorization header: authMiddleware rejects before the handler runs.
  const denied = await app.request(`${EBAY_PREFIX}/listings/publish`, {
    method: "POST",
  });
  assertEquals(denied.status, 401, "an unauthenticated eBay route must not reach its handler");

  // Skip-listed: the handler runs and authenticates itself.
  const allowed = await app.request(`${EBAY_PREFIX}/oauth/callback?state=abc`);
  assertEquals(allowed.status, 200);
  assertEquals(await allowed.json(), { reached: true });
});
