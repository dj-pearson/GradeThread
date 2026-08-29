// Auth-coverage guard for the FlipDesk surface (US-268 hardening).
//
// FlipDesk auth is applied with a PER-PATH whitelist (`app.use("/api/flipdesk/
// <path>", authMiddleware)`) rather than a single `/api/flipdesk/*` wildcard,
// because some routers deliberately host public sub-paths (OAuth callbacks,
// provider webhooks) alongside authed ones. The hazard of that model: a
// developer can mount a brand-new router with `app.route(...)` and forget the
// matching `app.use(..., authMiddleware)` line, shipping a fully unauthenticated
// tenant endpoint. That already happened to `forecast` and `photo-profiles`.
//
// The eBay router is the ONE exception, as of US-2014 AC3: it grew to 80+ routes,
// which made per-path allowlisting untenable, so it now has a single
// `/api/flipdesk/ebay/*` mount plus a named skip-list (middleware/ebay-auth.ts).
// Everything below counts `ebayAuthMiddleware` as auth, because it is
// authMiddleware with an explicit, tested set of exemptions.
//
// This test fails the build if any mounted `/api/flipdesk/*` router has NO
// authMiddleware registered under its prefix — the exact "forgot the auth line
// entirely" mistake — unless the router is on the explicit PUBLIC allowlist.
// It intentionally does NOT try to prove sub-path-level coverage (the per-path
// model is by design); it guarantees every router has a deliberate auth posture.

import { assert } from "@std/assert";

const mainSrc = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));

// Routers that are intentionally public (no auth runs; they verify the caller
// from a signed provider payload / fixed secret instead). Adding a router here
// is a conscious decision that should be reviewed.
const PUBLIC_FLIPDESK_ROUTERS = new Set<string>([
  "/api/flipdesk/webhooks", // provider webhooks — signature-verified per handler
]);

function matchAll(src: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

// Every router mount under /api/flipdesk.
const mounts = matchAll(
  mainSrc,
  /app\.route\(\s*"(\/api\/flipdesk\/[^"]+)"/g,
);

// Every path that has authMiddleware applied.
//
// Two wrappers count, and both are authMiddleware with one explicit, tested
// change rather than a looser posture:
//   ebayAuthMiddleware              (US-2014 AC3) — same auth, named skip-list.
//   extensionOrUserAuthMiddleware   (US-2723)     — same auth, plus the signed
//     extension token the browser extension actually holds. Required on the two
//     route groups the extension calls; under plain authMiddleware every one of
//     its requests 401'd.
const authPaths = matchAll(
  mainSrc,
  /app\.use\(\s*"(\/api\/flipdesk\/[^"]+)"\s*,\s*(?:authMiddleware|ebayAuthMiddleware|extensionOrUserAuthMiddleware)\s*\)/g,
).map((p) => p.replace(/\/\*$/, "").replace(/\/$/, ""));

Deno.test("every FlipDesk router mount has an auth posture (authed or explicitly public)", () => {
  assert(mounts.length > 0, "expected to find /api/flipdesk router mounts in main.ts");

  const uncovered: string[] = [];
  for (const mount of mounts) {
    if (PUBLIC_FLIPDESK_ROUTERS.has(mount)) continue;
    const prefix = mount.replace(/\/$/, "");
    const covered = authPaths.some(
      (p) => p === prefix || p.startsWith(prefix + "/"),
    );
    if (!covered) uncovered.push(mount);
  }

  assert(
    uncovered.length === 0,
    `These /api/flipdesk routers are mounted but have NO authMiddleware under their prefix ` +
      `(add an app.use("<prefix>/*", authMiddleware), or add to PUBLIC_FLIPDESK_ROUTERS if ` +
      `genuinely public): ${uncovered.join(", ")}`,
  );
});

// US-1623 PATH-LEVEL eBay coverage lived here until US-2014 AC3. It diffed every
// declared eBay route against the ~35-entry per-path allowlist, because a route
// outside that allowlist got no auth at all. The allowlist is gone: main.ts now
// has ONE app.use("/api/flipdesk/ebay/*", ebayAuthMiddleware) and the only exit is
// the named skip-list in middleware/ebay-auth.ts.
//
// The check was DELETED rather than updated because against a wildcard it can no
// longer fail — every route starts with the prefix — and a test that cannot fail
// reads like coverage while providing none. Its real property (an eBay route is
// authed unless someone wrote down why not) is asserted more sharply in
// ebay-auth-coverage_test.ts, which pins the exempt set to EXACTLY the skip-list
// and drives the middleware for real.
//
// Worth recording: its own exemption list had the bug the inversion removes. It
// treated "/sync/" as a PREFIX, so /sync/performance/me — a signed-in seller's
// "Sync now" (US-2233) — was exempt from the coverage check by accident. The new
// skip-list matches exact paths and has a case pinning that sibling.

// ── US-1639: GENERALIZED deny-by-default guard (beyond /api/flipdesk/*) ───────
//
// The guard above only covers the FlipDesk surface. The same "forgot the
// auth line entirely" mistake can happen on ANY new `/api/*` router (a fresh
// `app.route(...)` with no matching auth `app.use`). This guard extends the
// prefix-level check to EVERY `/api/*` router mount so a new tenant endpoint
// mounted elsewhere can't ship fully unauthenticated and uncaught.
//
// "Auth posture" = at least one auth middleware line (authMiddleware,
// adminAuthMiddleware, or apiKeyAuthMiddleware) whose prefix nests with the
// mount in either direction (a broad parent like `/api/payments/*` covers the
// `/api/payments/appstore` sub-mount; a specific child like
// `/api/flipdesk/ebay/listings/*` covers the `/api/flipdesk/ebay` router). A
// router with NO such line must be on PUBLIC_API_ROUTERS — a reviewed decision
// (webhooks, cron schedulers, tracking pixels, provider/auth hooks, public
// content). This is the SAME prefix-level semantics as the FlipDesk guard: it
// proves a deliberate posture per router, not sub-path-level coverage.
const PUBLIC_API_ROUTERS = new Set<string>([
  // Provider / platform webhooks — signature- or secret-verified per handler.
  "/api/webhooks", // Stripe
  "/api/webhooks/appstore", // Apple App Store Server Notifications
  "/api/webhooks/google-play", // Google Play RTDN (GOOGLE_RTDN_WEBHOOK_SECRET-verified)
  "/api/flipdesk/webhooks", // marketplace provider webhooks
  "/api/auth/hooks", // Supabase auth hooks (shared-secret verified)
  "/api/email", // SES/SNS bounce+engagement webhooks
  // Cron / scheduler entrypoints — authenticated by the job secret, mounted
  // outside the user-auth group.
  "/api/maintenance",
  "/api/content/scheduler",
  "/api/newsletter/scheduler",
  // Deliberately public read/track surfaces.
  "/api/grading/public", // public grade lookups
  "/api/guarantee", // public guarantee terms
  "/api/changelog", // public changelog
  "/api/content/public", // public blog/content read
  // US-2573: the anonymous Help Center read that the /help SSR Function calls.
  // Public is the point — these pages are meant to be indexed. The gate is
  // visibility, not auth: the handler filters to visibility='public' via
  // visibilitiesFor("anon"), and 00602's anon RLS policy filters again for
  // anything that reaches Postgres with the anon key. 'members' and 'internal'
  // articles are served by /api/help and /api/content/help, both authed.
  "/api/content/public/help",
  "/api/newsletter", // public subscribe
  "/api/drip", // public unsubscribe / drip landing
  // US-2911 AC5: the minimum-client-version floor. Public BY NECESSITY, which
  // is a stronger reason than the others on this list: an app old enough to be
  // below the floor may be old enough that its auth no longer works, and the
  // one thing it must still be able to learn is that it needs updating. The
  // handler reads a single system setting and returns a number - no tenant
  // data, no user lookup, nothing to scope.
  "/api/client-version",
  "/api/drip-track", // open/click tracking pixels
  "/api/campaign-track", // campaign tracking pixels
]);

// US-2723: extensionOrUserAuthMiddleware joins the list for the same reason
// ebayAuthMiddleware is on it — it IS authMiddleware, with one explicit and
// separately tested change (it also accepts the signed extension token the
// browser extension holds). extension-auth_test.ts keeps it narrow: it may only
// be mounted on the route groups the extension actually calls.
const AUTH_MW =
  "(?:authMiddleware|adminAuthMiddleware|apiKeyAuthMiddleware|ebayAuthMiddleware|mcpAuthMiddleware|extensionOrUserAuthMiddleware)";

const apiMounts = [
  ...new Set(
    matchAll(mainSrc, /app\.route\(\s*"(\/api\/[^"]+)"/g).map((p) =>
      p.replace(/\/$/, "")
    ),
  ),
];

const apiAuthPrefixes = matchAll(
  mainSrc,
  new RegExp(`app\\.use\\(\\s*"(\\/api\\/[^"]+)"\\s*,\\s*${AUTH_MW}\\s*\\)`, "g"),
).map((p) => p.replace(/\/\*$/, "").replace(/\/$/, ""));

Deno.test("every /api router mount has an auth posture (authed or explicitly public) — US-1639", () => {
  assert(apiMounts.length > 0, "expected /api router mounts in main.ts");
  assert(apiAuthPrefixes.length > 0, "expected auth middleware lines in main.ts");

  const uncovered: string[] = [];
  for (const mount of apiMounts) {
    if (PUBLIC_API_ROUTERS.has(mount)) continue;
    const prefix = mount.replace(/\/$/, "");
    // Nested either way: a parent auth prefix covers a child mount, and a
    // child auth prefix proves the parent router has a posture.
    const covered = apiAuthPrefixes.some(
      (p) =>
        p === prefix ||
        p.startsWith(prefix + "/") ||
        prefix.startsWith(p + "/"),
    );
    if (!covered) uncovered.push(mount);
  }

  assert(
    uncovered.length === 0,
    `These /api routers are mounted but have NO auth middleware under/over their ` +
      `prefix — a forgotten auth line ships an unauthenticated tenant endpoint. Add ` +
      `app.use("<prefix>/*", authMiddleware) in main.ts, or add to PUBLIC_API_ROUTERS ` +
      `if genuinely public: ${uncovered.join(", ")}`,
  );
});

// US-9103: the guard above only reads mounts under /api, so a router mounted at
// a top-level path is invisible to it — it reports green for a prefix it never
// looked at. /mcp is the first such router (the connector URL a seller pastes
// cannot live under /api), so the gap is closed here rather than after the next
// one. Every non-/api mount must appear below with a stated posture, and an
// entry that stops matching a real mount fails too, so the list can only track
// reality.
const NON_API_ROUTER_POSTURE = new Map<string, string>([
  // Liveness/readiness probes. Deliberately unauthenticated: an auth dependency
  // in a restart probe crash-loops a healthy container during an auth outage.
  ["/health", "public"],
  // US-9122: the OAuth token and revoke endpoints. PUBLIC, and necessarily so:
  // the credential IS the request body, and a token endpoint behind auth is a
  // loop. What protects them is the grant material itself - a code that must
  // match its PKCE challenge, a refresh token that must be the live generation
  // - plus MCP_OAUTH_ENABLED, which 404s the whole prefix until the flow is
  // real. Revoke deliberately answers 200 for an unknown token (RFC 7009).
  ["/oauth", "public"],
  // US-9104: the MCP endpoint authenticates with an API key (Bearer or
  // X-API-Key) through mcpAuthMiddleware, and gates on the connector plan flag.
  ["/mcp", "authed"],
]);

const nonApiMounts = [
  ...new Set(
    matchAll(mainSrc, /app\.route\(\s*"(\/[^"]+)"/g)
      .filter((p) => !p.startsWith("/api"))
      .map((p) => p.replace(/\/$/, "")),
  ),
];

const nonApiAuthPrefixes = matchAll(
  mainSrc,
  new RegExp(`app\\.use\\(\\s*"(\\/[^"]+)"\\s*,\\s*${AUTH_MW}\\s*\\)`, "g"),
)
  .filter((p) => !p.startsWith("/api"))
  .map((p) => p.replace(/\/\*$/, "").replace(/\/$/, ""));

Deno.test("every non-/api router mount has a DECLARED auth posture — US-9103", () => {
  const undeclared = nonApiMounts.filter((m) => !NON_API_ROUTER_POSTURE.has(m));
  assert(
    undeclared.length === 0,
    `These routers are mounted outside /api and are invisible to the US-1639 guard, ` +
      `so their posture is unreviewed. Add each to NON_API_ROUTER_POSTURE with "authed" ` +
      `or "public" and a reason: ${undeclared.join(", ")}`,
  );

  const stale = [...NON_API_ROUTER_POSTURE.keys()].filter((m) => !nonApiMounts.includes(m));
  assert(
    stale.length === 0,
    `NON_API_ROUTER_POSTURE names mounts that no longer exist in main.ts, so those ` +
      `entries assert nothing. Remove them: ${stale.join(", ")}`,
  );

  const missingAuth = [...NON_API_ROUTER_POSTURE.entries()]
    .filter(([, posture]) => posture === "authed")
    .map(([mount]) => mount)
    .filter((mount) =>
      !nonApiAuthPrefixes.some(
        (p) => p === mount || p.startsWith(mount + "/") || mount.startsWith(p + "/"),
      )
    );
  assert(
    missingAuth.length === 0,
    `These mounts are declared "authed" but main.ts has no auth middleware line for ` +
      `their prefix: ${missingAuth.join(", ")}`,
  );
});
