// US-1928: role-floor coverage guard for mutating FlipDesk + grade routes.
//
// The auth-coverage guard (flipdesk-auth-coverage_test.ts) fails the build if a
// router mounts without authMiddleware — it proves a request is AUTHENTICATED. It
// says nothing about AUTHORIZATION: the ROLE FLOOR that stops a read-only member
// (a `viewer`) from writing / spending AI credits in the owner's tenant. Those
// floors were hand-rolled inside a handful of handlers (`if (role === "viewer")`
// / `roleAtLeast(...)`), and an audit found MOST mutating routes had none — a
// viewer could publish, ship, or trigger AI spend on the owner's account.
//
// The fix is a single baseline: `blockViewerWrites` (middleware/workspace.ts),
// mounted broadly on `/api/flipdesk/*` and `/api/grade/*` AFTER workspaceMiddleware,
// blocks a viewer from ANY mutating verb across the surface in one place. Routes
// needing a HIGHER floor (admin disconnects, listing_manager publishes) keep their
// inline check on top.
//
// This guard makes that baseline a build-time invariant: every FlipDesk/grade
// router mount must sit under a `blockViewerWrites` mount, so a new mutating route
// can't ship outside the viewer floor, and the baseline can't be silently removed.
// It's prefix-level (like the auth-coverage guard) — robust against handlers that
// delegate their floor to a shared helper, which a per-route body scan would
// mis-flag.

import { assert } from "@std/assert";

const mainSrc = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));

function matchAll(src: string, re: RegExp, group = 1): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(re)) out.push(m[group]);
  return out;
}

// Prefixes carrying the blockViewerWrites baseline, normalized (drop trailing /*).
const coverPrefixes = matchAll(
  mainSrc,
  /app\.use\(\s*"([^"]+)"\s*,\s*blockViewerWrites\s*\)/g,
).map((p) => p.replace(/\/\*$/, "").replace(/\/$/, ""));

// Every FlipDesk/grade router mount that could host a mutating route.
const surfaceMounts = [
  ...new Set(
    matchAll(mainSrc, /app\.route\(\s*"(\/api\/(?:flipdesk|grade)[^"]*)"/g).map(
      (p) => p.replace(/\/$/, ""),
    ),
  ),
];

function covered(mount: string): boolean {
  return coverPrefixes.some(
    (p) => mount === p || mount.startsWith(p + "/") || p.startsWith(mount + "/"),
  );
}

Deno.test("blockViewerWrites is mounted on both surface roots — US-1928", () => {
  assert(
    coverPrefixes.includes("/api/flipdesk"),
    "expected app.use(\"/api/flipdesk/*\", blockViewerWrites) in main.ts",
  );
  assert(
    coverPrefixes.includes("/api/grade"),
    "expected app.use(\"/api/grade/*\", blockViewerWrites) in main.ts",
  );
});

Deno.test("every FlipDesk/grade router mount sits under the viewer-write floor — US-1928", () => {
  assert(surfaceMounts.length > 0, "expected /api/flipdesk|grade router mounts in main.ts");

  const uncovered = surfaceMounts.filter((m) => !covered(m));
  assert(
    uncovered.length === 0,
    `These FlipDesk/grade router mounts are NOT under a blockViewerWrites mount, so a ` +
      `viewer could perform writes in the owner's tenant. Add app.use("<prefix>/*", ` +
      `blockViewerWrites) covering them (or extend an existing broad mount): ${uncovered.join(", ")}`,
  );
});

Deno.test("blockViewerWrites runs AFTER workspaceMiddleware (role must be resolved first) — US-1928", () => {
  // The baseline reads c.get("workspaceRole"), set by workspaceMiddleware, so its
  // mount must be registered after at least one workspaceMiddleware mount.
  const firstBlock = mainSrc.search(/app\.use\([^)]*blockViewerWrites\s*\)/);
  const lastWorkspace = mainSrc.lastIndexOf("workspaceMiddleware)");
  assert(firstBlock > -1, "expected a blockViewerWrites mount in main.ts");
  assert(lastWorkspace > -1, "expected workspaceMiddleware mounts in main.ts");
  assert(
    firstBlock > lastWorkspace,
    "blockViewerWrites must be mounted AFTER the workspaceMiddleware lines so the " +
      "role is resolved before the write floor runs",
  );
});
