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
const authPaths = matchAll(
  mainSrc,
  /app\.use\(\s*"(\/api\/flipdesk\/[^"]+)"\s*,\s*authMiddleware\s*\)/g,
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

// US-1623: PATH-LEVEL coverage for the eBay router. The prefix-level guard above
// passes as long as the router has SOME auth line — but eBay hosts ~20 sub-path
// groups, and five (analytics, compliance, finances, catalog, promotions)
// shipped with NO whitelist entry, so authMiddleware never ran and those
// handlers (which read workspaceOwnerId ?? userId) failed closed to 401 even for
// signed-in sellers. CI missed it because the prefix guard only needs one auth
// line per router. This diffs EVERY declared user route against the whitelist.
const ebaySrc = Deno.readTextFileSync(
  new URL("../routes/flipdesk-ebay.ts", import.meta.url),
);

// eBay sub-paths that intentionally run WITHOUT user auth — kept explicit so a
// new one is a conscious decision:
//   crons authenticate via the job secret (mounted outside the authed group);
//   the OAuth callback is a provider redirect keyed on the OAuth `state`, not a JWT.
const EBAY_PUBLIC_OR_CRON_PREFIXES = ["/jobs/", "/sync/"];
const EBAY_PUBLIC_OR_CRON_EXACT = new Set<string>([
  "/oauth/callback", // eBay redirect — verified via OAuth state, not a JWT
  "/oauth/refresh", // ebay-token-refresh cron (job secret)
]);

const ebayRoutePaths = matchAll(
  ebaySrc,
  /flipdeskEbayRoutes\.(?:get|post|put|delete)\(\s*"(\/[^"]+)"/g,
).filter(
  (p) =>
    !EBAY_PUBLIC_OR_CRON_EXACT.has(p) &&
    !EBAY_PUBLIC_OR_CRON_PREFIXES.some((c) => p.startsWith(c)),
);

const ebayAuthPrefixes = matchAll(
  mainSrc,
  /app\.use\(\s*"(\/api\/flipdesk\/ebay\/[^"]+)"\s*,\s*authMiddleware\s*\)/g,
).map((p) => p.replace(/\/\*$/, "").replace(/\/$/, ""));

Deno.test("every user-facing eBay route path has an authMiddleware whitelist entry (US-1623)", () => {
  assert(ebayRoutePaths.length > 0, "expected eBay route definitions in flipdesk-ebay.ts");
  assert(ebayAuthPrefixes.length > 0, "expected eBay authMiddleware lines in main.ts");

  const uncovered: string[] = [];
  for (const route of ebayRoutePaths) {
    const full = `/api/flipdesk/ebay${route}`;
    const covered = ebayAuthPrefixes.some(
      (p) => full === p || full.startsWith(p + "/"),
    );
    if (!covered) uncovered.push(route);
  }

  assert(
    uncovered.length === 0,
    `These eBay routes have NO authMiddleware whitelist entry, so they 401 even for ` +
      `signed-in sellers — add app.use("/api/flipdesk/ebay/<prefix>/*", authMiddleware) in ` +
      `main.ts (or add to EBAY_PUBLIC_OR_CRON_* if genuinely public): ${uncovered.join(", ")}`,
  );
});

// ── US-1639: GENERALIZED deny-by-default guard (beyond /api/flipdesk/*) ───────
//
// The two guards above only cover the FlipDesk surface. The same "forgot the
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
  "/api/newsletter", // public subscribe
  "/api/drip", // public unsubscribe / drip landing
  "/api/drip-track", // open/click tracking pixels
  "/api/campaign-track", // campaign tracking pixels
]);

const AUTH_MW = "(?:authMiddleware|adminAuthMiddleware|apiKeyAuthMiddleware)";

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
