#!/usr/bin/env node
// Find exported edge-lib functions that NO production code calls.
//
// WHY THIS EXISTS. Green tests on a module nothing imports are worse than no
// tests: they actively signal that a feature works. Three real defects were
// found this way in one sweep (2026-07-18), each a story marked passes:true
// whose deliverable never ran:
//
//   • US-1891 (P1) — the edge half of backwards title sync was never wired, so
//     an item edit from anywhere but the web canvas leaves the stale brand in
//     listing_title. Filed as US-1995.
//   • SYNC_SOURCE_OF_TRUTH — buildListingPullPatch has no callers and encodes a
//     STRICTER contract than the inline path that actually runs, so its tests
//     read as proof of a rule that is not enforced. Filed as US-1994.
//   • US-933 — the unified trigger engine (drip-trigger.ts) was superseded by
//     inline logic in jobs-journey-tick.ts and is entirely dead.
//
// THE KEY DETAIL: references are counted INCLUDING the defining file. A helper
// exported purely for testability is still used internally and is NOT dead.
// Only zero references anywhere — even at home — means "built, tested, never
// connected". Counting cross-file only reports ~34% of the codebase and is
// useless.
//
// Usage:
//   node scripts/audit-unwired-exports.mjs            # summary
//   node scripts/audit-unwired-exports.mjs --all      # include untested ones
//   node scripts/audit-unwired-exports.mjs --module   # only whole dead modules
//
// This is a REPORT, not a gate. Plenty of hits are legitimate — test-only reset
// helpers, deliberate public API. Read it, don't CI-fail on it.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const edge = join(root, "services", "edge-functions", "src");
const libDir = join(edge, "lib");
const testsDir = join(edge, "tests");
if (!existsSync(libDir)) {
  console.error(`No edge lib dir at ${libDir}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const modulesOnly = args.includes("--module");
const norm = (p) => p.split(sep).join("/");

// The caller corpus is src/ MINUS tests, PLUS services/edge-functions/scripts/.
//
// That last part was a real blind spot in the first version. Operator scripts
// live outside src/ and are genuine callers: scripts/measure-eval.ts imports
// measure-eval-stats.ts and calls releaseGate(), so the module was reported dead
// when it is the backbone of the US-1582 accuracy gate. An audit that
// over-reports gets ignored exactly as fast as one that under-reports.
const prodFiles = [];
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== "tests") walk(p);
    } else if (e.name.endsWith(".ts")) prodFiles.push(p);
  }
}
walk(edge);
const edgeScripts = join(root, "services", "edge-functions", "scripts");
if (existsSync(edgeScripts)) walk(edgeScripts);
const corpus = prodFiles.map((p) => [norm(p), readFileSync(p, "utf8")]);

const testSrc = existsSync(testsDir)
  ? readdirSync(testsDir).filter((f) => f.endsWith(".ts")).map((f) =>
    readFileSync(join(testsDir, f), "utf8")
  )
  : [];

// A module is "reachable" only via a real import statement — a mention in a
// comment does not count. drip-trigger.ts looked imported twice until this
// distinction was drawn; both were prose.
function moduleImported(libFile) {
  const stem = libFile.replace(/\.ts$/, "");
  const re = new RegExp(`from\\s+"[^"]*/${stem}\\.ts"`);
  return corpus.some(([p, s]) => !p.endsWith(`/lib/${libFile}`) && re.test(s));
}

const rows = [];
const deadModules = [];
for (const f of readdirSync(libDir).filter((x) => x.endsWith(".ts"))) {
  const self = norm(join(libDir, f));
  const src = readFileSync(join(libDir, f), "utf8");
  const names = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  if (!names.length) continue;

  // WHOLE-MODULE DEADNESS IS DECIDED BY THE IMPORT GRAPH, NOT BY REF COUNTS.
  //
  // The first version of this script got that wrong and missed title-sync.ts —
  // the very module that motivated it. Its exports call EACH OTHER (syncTitle
  // uses applyTitleSubstitution), so per-function reference counting saw
  // "referenced" and cleared a module nothing on earth imports. Internal
  // cohesion is not reachability. If no production file imports the module, it
  // is dead no matter how busy it looks inside.
  if (!moduleImported(f)) {
    const testRefs = names.reduce((a, n) => {
      const re = new RegExp("\\b" + n + "\\b", "g");
      return a + testSrc.reduce((b, s) => b + (s.match(re) || []).length, 0);
    }, 0);
    deadModules.push({ file: f, count: names.length, testRefs });
    continue;
  }

  // Live module: now per-function counting is meaningful.
  for (const name of names) {
    const re = new RegExp("\\b" + name + "\\b", "g");
    let refs = 0;
    for (const [p, s] of corpus) {
      let n = (s.match(re) || []).length;
      if (p === self) n -= 1; // discount the declaration itself
      refs += n;
    }
    if (refs > 0) continue;
    const testRefs = testSrc.reduce((a, s) => a + (s.match(re) || []).length, 0);
    rows.push({ file: f, name, testRefs });
  }
}
deadModules.sort((a, b) => b.testRefs - a.testRefs);

console.log("── WHOLE MODULES NOTHING IMPORTS ──────────────────────────────");
console.log("Every export unwired AND no real import statement anywhere.\n");
if (!deadModules.length) console.log("  (none)");
for (const m of deadModules) {
  console.log(`  ${m.file.padEnd(30)} ${String(m.count).padStart(2)} export(s), ${m.testRefs} test refs`);
}

if (!modulesOnly) {
  const tested = rows.filter((r) => r.testRefs > 0).sort((a, b) => b.testRefs - a.testRefs);
  const untested = rows.filter((r) => r.testRefs === 0);
  console.log("\n── TESTED BUT NEVER CALLED (inside a live module) ─────────────");
  console.log(`${tested.length} function(s) — some are legitimate test-only helpers.\n`);
  for (const r of tested) {
    console.log(`  ${r.file.padEnd(30)} ${r.name.padEnd(34)} (${r.testRefs} test refs)`);
  }
  if (showAll) {
    console.log(`\n── NO PROD REFS, NO TESTS EITHER (${untested.length}) ──`);
    for (const r of untested) console.log(`  ${r.file.padEnd(30)} ${r.name}`);
  } else {
    console.log(`\n(${untested.length} more with no tests either — pass --all)`);
  }
}
console.log("\nDead MODULES are the high-signal hits. Verify each by hand before acting:");
console.log("a superseded engine (US-933) and a half-wired feature (US-1891) look identical here.");
