#!/usr/bin/env node
// US-417: CI bundle-size budget + code-splitting guard.
//
// The landing page and every cold app load pull the EAGER chunk graph — the
// entry chunk plus everything it statically imports (Vite emits a <modulepreload>
// for each). A stray top-level `import` of a heavy primitive (a radix
// Dialog/Select/Popover, the TipTap blog editor, recharts, etc.) silently rides
// into that graph and bloats first paint for users who never open that surface.
// Rollup's per-route code-splitting normally keeps those lazy, but nothing fails
// the build if it regresses. This script is that gate:
//
//   1. Asserts a gzip-size budget on the entry chunk AND the whole eager graph.
//   2. Asserts radix Dialog/Select/Popover and TipTap stay OUT of the eager
//      graph (they must remain in their own route/lazy chunks), and confirms the
//      TipTap blog-editor deps actually resolved to a non-eager chunk.
//
// It reads build-meta/bundle-modules.json (emitted by the bundleModulesManifest
// Vite plugin — chunk → module ids + static imports) and the gzipped byte sizes
// of the built chunks in dist/. Run AFTER `npm run build` (or `vite build`).
// Wired into ci.yml and `npm run verify:web`.

import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const manifestPath = join(root, "build-meta", "bundle-modules.json");

// ── Budgets (gzipped) ────────────────────────────────────────────────────────
// Set with headroom over the current size so routine dependency bumps don't trip
// it, but a heavy import landing in the eager graph will. Tighten as the app
// slims down. Current (2026-06-27): entry ~54.6 KB, eager total ~205.0 KB.
// (Entry grew from ~48.2 KB on 2026-06-19 with another sprint of feature work —
// no forbidden heavy primitive leaked in (the FORBIDDEN_IN_EAGER guard below
// still catches those, and the eager-total budget at 215 KB guards the cold-load
// graph). The growth is the route table itself: 171 lazy() route definitions +
// path strings in src/routes/index.tsx, which is irreducible without splitting
// the router. Budget bumped to restore ~headroom; worth a future entry-chunk
// slim-down pass — e.g. moving the admin route subtree behind its own lazy
// sub-router so its path strings leave the eager chunk.)
const ENTRY_GZ_BUDGET_KB = 56;
const EAGER_TOTAL_GZ_BUDGET_KB = 215;

// Heavy code-split primitives that must NEVER ride in the eager graph. Matched
// against module ids (node_modules paths). NOTE: @radix-ui/react-slot and
// /react-compose-refs are deliberately allowed — Button pulls those tiny helpers
// and Button renders on public/landing pages (see vite.config manualChunks note).
const FORBIDDEN_IN_EAGER = [
  { label: "radix Dialog", re: /node_modules\/@radix-ui\/react-dialog\// },
  { label: "radix Select", re: /node_modules\/@radix-ui\/react-select\// },
  { label: "radix Popover", re: /node_modules\/@radix-ui\/react-popover\// },
  { label: "TipTap", re: /node_modules\/@tiptap\// },
];

const TIPTAP_RE = /node_modules\/@tiptap\//;

function fail(msg) {
  console.error(`\n\x1b[31m\x1b[1m[bundle-budget] FAIL\x1b[0m ${msg}\n`);
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  fail(`build-meta/bundle-modules.json not found — run \`npm run build\` first.`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// ── Compute the eager closure: entry chunk(s) + transitive static imports ─────
const entries = Object.entries(manifest)
  .filter(([, c]) => c.isEntry)
  .map(([f]) => f);
if (entries.length === 0) fail("no entry chunk found in bundle manifest.");

const eager = new Set();
const queue = [...entries];
while (queue.length) {
  const f = queue.shift();
  if (eager.has(f) || !manifest[f]) continue;
  eager.add(f);
  for (const imp of manifest[f].imports) queue.push(imp);
}

function gzKb(fileName) {
  const p = join(distDir, fileName);
  if (!existsSync(p)) fail(`chunk ${fileName} listed in manifest but missing from dist/.`);
  return gzipSync(readFileSync(p), { level: 9 }).length / 1024;
}

// ── 1. Size budgets ──────────────────────────────────────────────────────────
const errors = [];
let eagerTotalKb = 0;
const rows = [];
for (const f of [...eager].sort()) {
  const kb = gzKb(f);
  eagerTotalKb += kb;
  rows.push({ f, kb, isEntry: manifest[f].isEntry });
}

console.log("\n\x1b[1mEager (landing/cold-load) chunk graph:\x1b[0m");
for (const r of rows.sort((a, b) => b.kb - a.kb)) {
  console.log(
    `  ${r.kb.toFixed(2).padStart(8)} KB gz  ${r.isEntry ? "[entry]" : "       "}  ${r.f}`,
  );
}
console.log(`  ${"".padStart(8)}          ─────`);
console.log(`  ${eagerTotalKb.toFixed(2).padStart(8)} KB gz  total (${eager.size} chunks)\n`);

const entryKb = rows.filter((r) => r.isEntry).reduce((s, r) => s + r.kb, 0);
if (entryKb > ENTRY_GZ_BUDGET_KB) {
  errors.push(
    `entry chunk is ${entryKb.toFixed(2)} KB gz, over the ${ENTRY_GZ_BUDGET_KB} KB budget.`,
  );
}
if (eagerTotalKb > EAGER_TOTAL_GZ_BUDGET_KB) {
  errors.push(
    `eager graph is ${eagerTotalKb.toFixed(2)} KB gz, over the ${EAGER_TOTAL_GZ_BUDGET_KB} KB budget.`,
  );
}

// ── 2. Code-splitting guard: heavy primitives stay out of the eager graph ─────
for (const { label, re } of FORBIDDEN_IN_EAGER) {
  for (const f of eager) {
    const hits = manifest[f].modules.filter((m) => re.test(m));
    if (hits.length) {
      errors.push(
        `${label} leaked into eager chunk ${f} (e.g. ${hits[0].split("node_modules/")[1]}). ` +
          `It must stay code-split into a route/lazy chunk.`,
      );
    }
  }
}

// ── 3. Confirm TipTap actually resolved lazily (blog-editor deps) ─────────────
const tiptapChunks = Object.entries(manifest)
  .filter(([, c]) => c.modules.some((m) => TIPTAP_RE.test(m)))
  .map(([f]) => f);
if (tiptapChunks.length === 0) {
  errors.push("expected TipTap to appear in some chunk, but found none — has the blog editor been removed?");
} else {
  const eagerTiptap = tiptapChunks.filter((f) => eager.has(f));
  if (eagerTiptap.length === 0) {
    console.log(
      `\x1b[2mTipTap is lazy: ${tiptapChunks.length} non-eager chunk(s) (e.g. ${tiptapChunks[0]}).\x1b[0m`,
    );
  }
  // (an eager TipTap chunk is already reported by the FORBIDDEN_IN_EAGER pass)
}

if (errors.length) {
  for (const e of errors) console.error(`  \x1b[31m✗\x1b[0m ${e}`);
  fail(`${errors.length} budget/code-splitting violation(s).`);
}

console.log(
  `\x1b[32m\x1b[1m[bundle-budget] OK\x1b[0m entry ${entryKb.toFixed(1)}/${ENTRY_GZ_BUDGET_KB} KB, ` +
    `eager ${eagerTotalKb.toFixed(1)}/${EAGER_TOTAL_GZ_BUDGET_KB} KB; ` +
    `radix Dialog/Select/Popover + TipTap confirmed code-split.\n`,
);
