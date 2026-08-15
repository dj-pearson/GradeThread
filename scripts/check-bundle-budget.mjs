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
// (2026-07-02: entry crossed 56 KB at 57.0 KB — same cause as before, route-table
// growth in src/routes/index.tsx; eager total was comfortably under at ~207 KB and
// no forbidden primitive leaked. Bumped for headroom; the lazy admin sub-router
// slim-down suggested above remains the real fix.)
// (2026-07-12: entry crossed 60 KB at 61.91 KB — same route-table growth in
// src/routes/index.tsx; eager total still comfortably under at ~212.35 KB and no
// forbidden primitive leaked. Bumped 60→64 for headroom; the lazy admin
// sub-router slim-down above is still the real fix and is now overdue.)
// (2026-08-15: the eager total FAILED at 215.10/215 and the ceiling was NOT
// raised. Two structural fixes had already been named here and both were taken:
// the admin subtree moved behind its own lazy sub-router (US-2112), and this
// time `routes/index.tsx` stopped importing COMPETITOR_ALTERNATIVES — a 16 KB
// editorial data set it read only to get five slugs, shipped to every landing
// page visitor. The slugs moved to `lib/seo/competitor-alternative-slugs.ts`
// with a test pinning the two lists in both directions. Entry 63.43 → 59.52,
// eager 215.10 → 211.19. Budgets left where they are: the headroom is the point
// of the exercise, and tightening them the same day would spend it again.
// THE NEXT ONE TO TAKE, when this fails again: the 73 `/dashboard/*` routes are
// still declared eagerly in index.tsx, behind an auth gate most visitors never
// pass — the same argument that moved admin.)
const ENTRY_GZ_BUDGET_KB = 64;
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

// ── 3b. Sentry must stay lazily loaded (US-2332) ─────────────────────────────
//
// vendor-sentry is ~475 KB and is observability, not a rendering dependency, so
// lib/sentry.ts wraps it behind a dynamic import. That façade is easy to bypass
// by accident: a module writes `import * as Sentry from "@sentry/react"`
// because the wrapper happens not to export the one function it needs, and
// every chunk that reaches that module now statically pulls 475 KB.
//
// That is not hypothetical. welcome-email.ts did exactly this — the wrapper
// offered captureException but not captureMessage — and because use-auth.ts
// reaches it, the chunk landed in 59 of 609 chunks. FORBIDDEN_IN_EAGER did not
// catch it, and could not: none of those 59 were eager, so nothing was breaking
// a first-load budget. The cost was paid on route navigation instead, which no
// existing check measures.
//
// The threshold is deliberately small rather than zero: the entry chunk carries
// Vite's dynamic-import dependency map, which names the file without importing
// it, so one reference is the correct steady state.
const SENTRY_RE = /node_modules\/@sentry\//;
const MAX_SENTRY_IMPORTERS = 2;

const sentryChunks = Object.entries(manifest)
  .filter(([, c]) => c.modules.some((m) => SENTRY_RE.test(m)))
  .map(([f]) => f);

if (sentryChunks.length === 0) {
  errors.push(
    "expected @sentry/* to appear in some chunk, but found none — has Sentry been removed? " +
      "If so, delete this check rather than leaving it passing vacuously.",
  );
} else {
  const importers = Object.entries(manifest)
    .filter(([f, c]) =>
      !sentryChunks.includes(f) &&
      (c.imports ?? []).some((imp) => sentryChunks.includes(imp))
    )
    .map(([f]) => f);
  if (importers.length > MAX_SENTRY_IMPORTERS) {
    errors.push(
      `${importers.length} chunks STATICALLY import vendor-sentry (max ${MAX_SENTRY_IMPORTERS}). ` +
        `Someone has added a top-level \`import ... from "@sentry/react"\`. Use the lazy ` +
        `façade in src/lib/sentry.ts — and if it lacks the function you need, ADD it there ` +
        `rather than reaching past it. Offenders: ${importers.slice(0, 5).join(", ")}`,
    );
  } else {
    console.log(
      `[2mSentry is lazy: ${importers.length} static importer(s), ${sentryChunks.length} sentry chunk(s).[0m`,
    );
  }
}

// US-2112: WARN BEFORE THE BREACH, WITH THE CAUSE ATTACHED.
//
// The documented history of this file is four ceiling raises (48.2 -> 54.6 ->
// 57.0 -> 61.91 -> 62.44), each attributed to route-table growth and each
// followed by a note that the real fix "remains overdue". That pattern is not
// carelessness — it is what happens when the budget first speaks on the PR that
// happens to cross it, which is almost never the PR that caused the growth and
// is usually under time pressure. The reflexive fix is then to raise the
// ceiling, because the alternative is blocking unrelated work.
//
// So: warn while there is still room to act, and name what is actually IN the
// chunk so the next person does not have to re-derive it. This never fails the
// build — a warning that can block is just a lower ceiling.
const HEADROOM_WARN_KB = 3;

function warnNearBudget(label, kb, budget, modules) {
  const headroom = budget - kb;
  if (headroom > HEADROOM_WARN_KB || headroom < 0) return;
  console.warn(
    `
[33m[1m[bundle-budget] NEAR LIMIT[0m ${label} ${kb.toFixed(2)}/${budget} KB gz ` +
      `— only ${headroom.toFixed(2)} KB left.`,
  );
  if (modules && modules.length) {
    const pkgs = new Map();
    for (const id of modules) {
      const m = String(id).match(/node_modules\/(?:\.pnpm\/)?((?:@[^/]+\/)?[^/]+)/);
      if (m) pkgs.set(m[1], (pkgs.get(m[1]) ?? 0) + 1);
    }
    const top = [...pkgs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (top.length) {
      console.warn(
        `  eager node_modules in this chunk: ` +
          top.map(([n, c]) => `${n}(${c})`).join(", "),
      );
    }
  }
  console.warn(
    `  [2mDo NOT reflexively raise the ceiling — see US-2112. The cause is
` +
      `  structural (the ~250-route eager route table in src/routes/index.tsx),
` +
      `  so raising it trades LCP on the marketing pages for one more PR.[0m
`,
  );
}

const entryFile = rows.find((r) => r.isEntry)?.f;
warnNearBudget(
  "entry",
  entryKb,
  ENTRY_GZ_BUDGET_KB,
  entryFile ? manifest[entryFile]?.modules : null,
);
warnNearBudget("eager total", eagerTotalKb, EAGER_TOTAL_GZ_BUDGET_KB, null);
if (errors.length) {
  for (const e of errors) console.error(`  \x1b[31m✗\x1b[0m ${e}`);
  fail(`${errors.length} budget/code-splitting violation(s).`);
}

console.log(
  `\x1b[32m\x1b[1m[bundle-budget] OK\x1b[0m entry ${entryKb.toFixed(1)}/${ENTRY_GZ_BUDGET_KB} KB, ` +
    `eager ${eagerTotalKb.toFixed(1)}/${EAGER_TOTAL_GZ_BUDGET_KB} KB; ` +
    `radix Dialog/Select/Popover + TipTap confirmed code-split.\n`,
);
