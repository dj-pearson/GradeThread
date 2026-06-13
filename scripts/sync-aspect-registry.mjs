#!/usr/bin/env node
// US-822: regenerate the vendored web copy of the eBay aspect registry from the
// single canonical source (services/edge-functions/src/lib/aspect-registry.ts).
//
// The edge TS module is the source of truth; the web composer vendors a JSON
// copy (src/lib/ebay-aspect-registry.json) so Vite/vitest can import it without
// reaching across the package boundary into the Deno edge code. A drift guard
// (services/edge-functions/src/tests/aspect-registry-drift_test.ts) fails CI if
// the vendored copy diverges — run this script to fix that:
//
//   npm run sync:aspects
//
// Requires Deno (already a project prerequisite for the edge lane). The actual
// work lives in scripts/sync-aspect-registry.deno.ts so Windows shell quoting
// can't mangle inline `deno eval` code.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const denoScript = resolve(here, "sync-aspect-registry.deno.ts");

const res = spawnSync(
  "deno",
  ["run", "--allow-read", "--allow-write", denoScript],
  { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
);

if (res.status !== 0) {
  console.error("sync-aspect-registry: deno run failed");
  process.exit(res.status ?? 1);
}
