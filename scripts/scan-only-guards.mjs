#!/usr/bin/env node
// US-2789: how many guards READ the source where they could CALL it?
//
// A source scan is the right instrument for a WIRING property — is this module
// mounted, does this registry list that route, do these two files agree. It is
// the wrong one for LOGIC, because it pins a spelling or a string position and
// stays green through any change that preserves them.
//
// That is not theoretical. Three guards in this repo were found blind while
// reading as coverage:
//
//   US-2739  six cases asserting against a re-implementation of the code they
//            guarded; changing the real function to Math.floor left them green.
//   US-2719  ten scans caught 1 of 7 sabotages. A behavioural test caught 7.
//   US-2789  submission-no-double-charge caught 0 of 6 — including the exact
//            double-charge regression it was written for.
//
// WHAT THIS IS NOT. It is not a gate and it does not fail. Most of the files it
// lists are correct as scans, and a threshold would only invite someone to add a
// throwaway `expect(fn())` to get under it. It is a WORKLIST, so the count can
// be shown to fall rather than asserted to.
//
//   node scripts/scan-only-guards.mjs           # the worklist
//   node scripts/scan-only-guards.mjs --count   # just the number, for a diff

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories holding vitest suites worth measuring. */
const DIRS = ["src/test", "src/lib/__tests__"];

/** Reading source rather than exercising it. */
const SCAN = /toContain\(|toMatch\(|readFileSync|\.test\(\s*(?:src|code|text)\b/g;

/**
 * Calling something and asserting on the result.
 *
 * Deliberately loose: `expect(someFn(` in any shape counts. A guard that calls
 * ANYTHING is out of scope here — the question is whether the file ever leaves
 * the text layer, not how thoroughly.
 */
const CALL = /expect\(\s*(?:await\s+)?[a-z][A-Za-z0-9_]*\s*\(/g;

function count(re, s) {
  return (s.match(re) ?? []).length;
}

const rows = [];
for (const dir of DIRS) {
  let entries;
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    continue; // the directory may not exist in a partial checkout
  }
  for (const name of entries) {
    if (!/\.(test|spec)\.tsx?$/.test(name)) continue;
    const rel = `${dir}/${name}`;
    const src = readFileSync(join(root, rel), "utf8");
    const scans = count(SCAN, src);
    const calls = count(CALL, src);
    // Six is the floor for "this file is mostly reading text". Below it a
    // stray readFileSync in an otherwise behavioural suite would show up.
    if (scans >= 6 && calls === 0) {
      rows.push({ rel, scans, lines: src.split("\n").length });
    }
  }
}

rows.sort((a, b) => b.scans - a.scans);

if (process.argv.includes("--count")) {
  console.log(rows.length);
  process.exit(0);
}

console.log(
  `\nGuards that scan the source and never call it: ${rows.length}\n` +
    "Not a failure list. A scan is right for WIRING and wrong for LOGIC —\n" +
    "the question per file is which one it is holding.\n",
);
for (const r of rows) {
  console.log(`  ${String(r.scans).padStart(3)} scans  ${String(r.lines).padStart(4)} lines  ${r.rel}`);
}
console.log(
  "\nConverted so far (each kept its scan for a property the call cannot see):\n" +
    "  US-2739  stepPrice           src/test/step-price.test.ts\n" +
    "  US-2719  buildSteps          src/test/cross-post-setup-steps.test.ts\n" +
    "  US-2789  decideSubmitAction  src/lib/__tests__/submit-action.test.ts\n",
);
