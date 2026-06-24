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
