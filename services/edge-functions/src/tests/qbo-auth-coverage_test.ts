// US-2997 — every /api/flipdesk/qbo route must be authenticated OR explicitly
// declared self-authenticating.
//
// The eBay module learned this the expensive way (US-2014): a per-path
// allowlist in main.ts means the default is OPEN, and a route added later that
// nobody adds to the list ships unauthenticated with nothing failing. This
// module starts closed, and this file pins the three things that keep it closed:
//
//   1. the single deny-by-default mount is still the mount;
//   2. the skip-list exempts EXACTLY the paths it claims, checked against every
//      route routes/qbo.ts actually declares;
//   3. each exemption's stated mechanism is still visible in its handler.
//
// Plus a behavioural pass, because a source scan cannot tell a middleware that
// matches paths wrongly from one that matches them correctly.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import {
  isQboSelfAuthenticating,
  qboAuthMiddleware,
  qboWorkspaceMiddleware,
  QBO_SELF_AUTHENTICATING,
} from "../middleware/qbo-auth.ts";

const MAIN = await Deno.readTextFile(new URL("../main.ts", import.meta.url));
const ROUTES = await Deno.readTextFile(new URL("../routes/qbo.ts", import.meta.url));

const PREFIX = "/api/flipdesk/qbo";

function declaredRoutes(): Array<{ method: string; path: string }> {
  return [
    ...ROUTES.matchAll(/qboRoutes\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g),
  ].map((m) => ({ method: m[1]!.toUpperCase(), path: m[2]! }));
}

Deno.test("the QuickBooks prefix has ONE deny-by-default auth mount", () => {
  const mounts = [
    ...MAIN.matchAll(
      /app\.use\(\s*"(\/api\/flipdesk\/qbo[^"]*)"\s*,\s*(authMiddleware|qboAuthMiddleware)\s*\)/g,
    ),
  ].map((m) => ({ path: m[1]!, mw: m[2]! }));

  assertEquals(
    mounts,
    [{ path: "/api/flipdesk/qbo/*", mw: "qboAuthMiddleware" }],
    "Auth for the QuickBooks module must stay a single wildcard mount with a " +
      "skip-list. A per-path app.use(..., authMiddleware) here restores the " +
      "open-by-default allowlist that cost eBay five silent holes. Put the " +
      "exemption in QBO_SELF_AUTHENTICATING instead, with its mechanism.",
  );
});

Deno.test("the router is mounted, and every declared route is real", () => {
  assert(
    MAIN.includes('app.route("/api/flipdesk/qbo", qboRoutes);'),
    "routes/qbo.ts must be mounted in main.ts, or none of this is reachable",
  );
  const routes = declaredRoutes();
  assert(routes.length >= 6, `expected the qbo routes to be declared, saw ${routes.length}`);
});

Deno.test("the skip-list exempts exactly the routes it names, and no others", () => {
  const declared = new Set(declaredRoutes().map((r) => r.path));
  for (const key of QBO_SELF_AUTHENTICATING.keys()) {
    assert(
      declared.has(key),
      `${key} is on the skip-list but routes/qbo.ts declares no such route. A ` +
        "key that matches nothing is a hole waiting for a route to be added " +
        "under it.",
    );
  }
  // And nothing else is exempt.
  for (const r of declaredRoutes()) {
    const exempt = isQboSelfAuthenticating(`${PREFIX}${r.path}`);
    assertEquals(
      exempt,
      QBO_SELF_AUTHENTICATING.has(r.path),
      `${r.method} ${r.path}: exemption disagrees with the declared skip-list`,
    );
  }
});

/**
 * The source of the handler for `path`, from its declaration to the next one.
 *
 * Crude, and deliberately so: anything cleverer would need a parser, and the
 * only question here is whether a mechanism appears inside the handler at all.
 */
function handlerBody(path: string): string | null {
  // Literal search rather than a built regex: the path contains slashes, and a
  // hand-escaped path is one backslash away from silently matching nothing —
  // which would make every assertion below pass for the wrong reason.
  const all = declaredRoutes();
  const hit = all.find((r) => r.path === path);
  if (!hit) return null;

  const starts = all
    .map((r) => ROUTES.indexOf(`qboRoutes.${r.method.toLowerCase()}("${r.path}"`))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  const from = ROUTES.indexOf(`qboRoutes.${hit.method.toLowerCase()}("${hit.path}"`);
  if (from < 0) return null;
  const next = starts.find((i) => i > from);
  return ROUTES.slice(from, next ?? ROUTES.length);
}

/**
 * What counts as authenticating yourself. A route on the skip-list that does
 * none of these is simply an open route with a comment on it.
 *
 * THIS LIST IS THE GUARD. An earlier version of this file checked the two known
 * exemptions by name, which meant a THIRD exemption added for an existing route
 * -- say `/mappings` -- passed every assertion here: the key matched a declared
 * route, the forward and reverse exemption checks agreed with each other, and
 * nothing ever asked what replaced the session. That sabotage was run and it
 * came back green.
 */
const MECHANISMS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "requireJobSecret", re: /requireJobSecret\(c\)/ },
  {
    id: "single-use OAuth state",
    re: /from\("qbo_oauth_states"\)[\s\S]{0,200}?\.delete\(\)/,
  },
];

Deno.test("every self-authenticating exemption still proves its mechanism", () => {
  // The exemption text names what replaces the session. If the handler stops
  // doing that -- or never did -- the exemption is a lie and the route is open.
  for (const path of QBO_SELF_AUTHENTICATING.keys()) {
    const body = handlerBody(path);
    assert(body, `${path} is exempt but no handler for it was found in routes/qbo.ts`);
    const found = MECHANISMS.filter((m) => m.re.test(body!)).map((m) => m.id);
    assert(
      found.length > 0,
      `${path} is on the skip-list but its handler shows no self-authenticating ` +
        `mechanism (looked for: ${MECHANISMS.map((m) => m.id).join(", ")}). ` +
        "An exemption without one is an unauthenticated route.",
    );
  }
});

Deno.test("the mechanism guard can actually fail (self-check)", () => {
  // A guard nobody has watched fail is a guard nobody knows works. /status is a
  // normal authenticated route: it must show no mechanism, so exempting it
  // would be caught.
  const body = handlerBody("/status");
  assert(body, "/status handler not found");
  assert(
    MECHANISMS.every((m) => !m.re.test(body!)),
    "/status appears to authenticate itself, which would make this self-check " +
      "vacuous. Pick a different ordinary route.",
  );
});

Deno.test("a sibling of a skip-listed path is NOT exempt", () => {
  // Exact match, not prefix. A prefix test would hand any future
  // /oauth/callback/... route the exemption meant for one path.
  assert(isQboSelfAuthenticating(`${PREFIX}/oauth/callback`));
  assert(isQboSelfAuthenticating(`${PREFIX}/oauth/callback/`));
  assert(!isQboSelfAuthenticating(`${PREFIX}/oauth/callback/extra`));
  assert(!isQboSelfAuthenticating(`${PREFIX}/oauth/start`));
  assert(!isQboSelfAuthenticating("/api/flipdesk/ebay/oauth/callback"));
});

Deno.test("workspace context does NOT 401 the session-free routes", async () => {
  // THIS SHIPPED BROKEN AND WAS CAUGHT IN PRODUCTION, before anyone tried to
  // connect. main.ts mounted the plain `workspaceMiddleware` as a wildcard over
  // /api/flipdesk/qbo/*, and that middleware answers 401 "Auth context missing"
  // the moment userId is absent. It is absent by definition on both exempt
  // routes: Intuit redirects a browser to /oauth/callback with no session, and
  // the cron calls /oauth/refresh with a job secret and no user.
  //
  // So the seller approved at Intuit, came back, and got a bare 401 -- the
  // connect flow could never complete. The refresh sweep died the same way,
  // silently, which is the exact failure AC6 exists to prevent. Neither was
  // visible from the route files; the bug was one line in main.ts.
  const app = new Hono();
  app.use(`${PREFIX}/*`, qboWorkspaceMiddleware);
  app.all(`${PREFIX}/*`, (c) => c.json({ reached: true }));

  for (const path of QBO_SELF_AUTHENTICATING.keys()) {
    const res = await app.request(`${PREFIX}${path}`);
    assertEquals(
      res.status,
      200,
      `${path} must reach its handler without a session, got ${res.status}`,
    );
    await res.body?.cancel();
  }

  // And an ordinary route still gets the workspace check.
  const guarded = await app.request(`${PREFIX}/status`);
  assertEquals(guarded.status, 401, "an ordinary route must still be scoped");
  await guarded.body?.cancel();
});

Deno.test("main.ts mounts the qbo-aware workspace middleware, not the plain one", () => {
  // A source check as well as the behavioural one above, because the behaviour
  // test passes against a correct middleware that nothing mounts.
  const mounts = [
    ...MAIN.matchAll(
      /app\.use\(\s*"(\/api\/flipdesk\/qbo[^"]*)"\s*,\s*(\w*[Ww]orkspace\w*)\s*\)/g,
    ),
  ].map((m) => ({ path: m[1]!, mw: m[2]! }));

  assertEquals(
    mounts,
    [{ path: "/api/flipdesk/qbo/*", mw: "qboWorkspaceMiddleware" }],
    "the plain workspaceMiddleware 401s the OAuth callback and the cron, which " +
      "breaks the whole connect flow. Use qboWorkspaceMiddleware, which skips " +
      "the same paths the auth skip-list does.",
  );
});

Deno.test("the middleware 401s a normal route and passes a skip-listed one", async () => {
  const app = new Hono();
  app.use(`${PREFIX}/*`, qboAuthMiddleware);
  app.all(`${PREFIX}/*`, (c) => c.json({ reached: true }));

  const closed = await app.request(`${PREFIX}/status`);
  assertEquals(closed.status, 401, "an unauthenticated normal route must 401");
  await closed.body?.cancel();

  const open = await app.request(`${PREFIX}/oauth/callback`);
  assertEquals(open.status, 200, "a skip-listed route must reach its handler");
  await open.body?.cancel();
});
