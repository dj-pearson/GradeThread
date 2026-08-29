#!/usr/bin/env node
// US-2912 AC5 — the lint and detekt baselines may only shrink.
//
// WHY A BASELINE NEEDS A RATCHET. A baseline is the right way to turn a gate on
// over an existing codebase: `warningsAsErrors = true` plus 250 accepted
// findings means the build fails on anything NEW while the old debt waits. That
// only holds while the baseline is regenerated deliberately. Regenerate it
// casually — `./gradlew :app:updateLintBaseline` after a red build — and the new
// finding is absorbed silently. The gate still reports green, and nothing
// anywhere says the number went up.
//
// That is not hypothetical here: HANDOFF-US-2502.md records the detekt baseline
// as the output of the one `:app:detektBaseline` run that created it, and
// nobody has read it since.
//
// THE RULE, matching `no-unlocalized-copy.py` deliberately so there is one shape
// to learn: the counts live in a committed JSON, a count may never RISE, and a
// count that FALLS must have its number lowered in the same commit. The second
// half is what stops the ceiling drifting above reality until it means nothing.
//
// Run:  node android/scripts/check-baseline-ratchet.mjs
//       node android/scripts/check-baseline-ratchet.mjs --self-test
//       node android/scripts/check-baseline-ratchet.mjs --rebaseline

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `new URL(...).pathname` — the latter is absolute on
// Windows and RELATIVE on Linux, which is green here and red in CI.
const ANDROID = dirname(dirname(fileURLToPath(import.meta.url)));

const SOURCES = [
  {
    key: "lint",
    path: join(ANDROID, "app", "lint-baseline.xml"),
    // Each finding is one <issue> element. Counting <location> instead would
    // over-count: a single issue can carry several locations.
    count: (xml) => (xml.match(/<issue\b/g) ?? []).length,
    regenerate: "./gradlew :app:updateLintBaseline",
  },
  {
    key: "detekt",
    path: join(ANDROID, "config", "detekt", "baseline.xml"),
    count: (xml) => (xml.match(/<ID>/g) ?? []).length,
    regenerate: "./gradlew :app:detektBaseline",
  },
];

const CEILING_PATH = join(ANDROID, "scripts", "baseline-ceiling.json");

function readCeiling() {
  return JSON.parse(readFileSync(CEILING_PATH, "utf8"));
}

function actual() {
  const out = {};
  for (const s of SOURCES) out[s.key] = s.count(readFileSync(s.path, "utf8"));
  return out;
}

/**
 * The guard's own test, run on EVERY invocation rather than behind the flag.
 *
 * A counter that silently returns 0 — a renamed file, a changed element name,
 * a regex that stops matching — reports "the baseline shrank to zero", which
 * looks like the debt was paid rather than like the guard going blind. These
 * fixtures are the smallest inputs that tell the two apart.
 */
function selfTest() {
  const cases = [
    ["lint counts <issue> elements", SOURCES[0].count('<issues><issue id="A"/><issue id="B"/></issues>'), 2],
    ["lint ignores <location>", SOURCES[0].count('<issue id="A"><location file="x"/><location file="y"/></issue>'), 1],
    ["lint on an empty baseline", SOURCES[0].count("<issues></issues>"), 0],
    ["detekt counts <ID>", SOURCES[1].count("<ID>A:1</ID><ID>B:2</ID>"), 2],
    ["detekt on an empty baseline", SOURCES[1].count("<SmellBaseline></SmellBaseline>"), 0],
  ];
  const bad = cases.filter(([, got, want]) => got !== want);
  for (const [name, got, want] of bad) {
    console.error(`  self-test FAILED: ${name} — got ${got}, expected ${want}`);
  }
  if (bad.length) return false;

  // And the counters must find something in the REAL files. Both returning 0
  // against a repo that has two populated baselines is the blind-guard case,
  // and it passes every fixture above.
  for (const s of SOURCES) {
    if (s.count(readFileSync(s.path, "utf8")) === 0) {
      console.error(`  self-test FAILED: ${s.key} counted 0 in ${s.path} — the parse is wrong`);
      return false;
    }
  }
  console.log(`check-baseline-ratchet: self-test OK (${cases.length} cases + both real files)`);
  return true;
}

function main() {
  if (process.argv.includes("--rebaseline")) {
    const next = { _comment: readCeiling()._comment, ...actual() };
    writeFileSync(CEILING_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`check-baseline-ratchet: rebaselined ${JSON.stringify(actual())}`);
    return 0;
  }

  if (!selfTest()) return 1;
  if (process.argv.includes("--self-test")) return 0;

  const ceiling = readCeiling();
  const now = actual();
  const problems = [];

  for (const s of SOURCES) {
    const allowed = ceiling[s.key];
    if (typeof allowed !== "number") {
      problems.push(`${s.key}: no ceiling recorded in ${CEILING_PATH}`);
      continue;
    }
    if (now[s.key] > allowed) {
      problems.push(
        `${s.key}: ${now[s.key]} findings, ceiling is ${allowed}. A baseline may only SHRINK.\n` +
          `    Fix the finding rather than regenerating (${s.regenerate}), or, if it is\n` +
          `    genuinely accepted, raise the ceiling in the same commit and say why.`,
      );
    } else if (now[s.key] < allowed) {
      problems.push(
        `${s.key}: ${now[s.key]} findings but the ceiling still says ${allowed}.\n` +
          `    Lower it in this commit: node android/scripts/check-baseline-ratchet.mjs --rebaseline\n` +
          `    A ceiling above reality is how a ratchet stops ratcheting.`,
      );
    }
  }

  if (problems.length) {
    console.error("check-baseline-ratchet: FAILED\n");
    for (const p of problems) console.error(`  ${p}\n`);
    return 1;
  }

  console.log(
    `check-baseline-ratchet: OK (lint ${now.lint}, detekt ${now.detekt}; both at their ceiling)`,
  );
  return 0;
}

process.exit(main());
