#!/usr/bin/env node
// US-3121: turn a finished screenshot run into the weights the shard planner
// reads.
//
// Run the whole set once and then this:
//   ./gradlew :app:verifyRoborazziDebug --tests '*ScreenshotTest' --continue
//   node scripts/weigh-screenshot-shards.mjs
//
// It reads app/build/test-results/testDebugUnitTest/TEST-*.xml - the JUnit XML
// Gradle writes per test CLASS, with the class's own elapsed time in it - and
// writes scripts/screenshot-shard-weights.json.
//
// WHY MEASURE AT ALL, when a shard could just count classes: because the count
// does not predict the time. On CI run 34223941706 two shards had 105 tests
// each and took 19m and 35m. Rendering cost is a property of what a screen
// draws, and the only way to know it is to have drawn it.
//
// The numbers are RELATIVE, so recording them on a developer machine is fine -
// a runner is slower across the board, and a schedule only needs the ratios.
// They go stale slowly and harmlessly: see the note at the top of
// plan-screenshot-shards.mjs for what a stale entry does and does not break.
//
// `--merge` (the default) keeps weights for classes this run did not cover, so
// a partial run - one shard's worth, say - updates what it measured and leaves
// the rest alone. `--replace` starts from empty instead.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const androidDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(androidDir, "app/build/test-results/testDebugUnitTest");
const weightsFile = join(androidDir, "scripts/screenshot-shard-weights.json");

const replace = process.argv.includes("--replace");

let files;
try {
  files = readdirSync(resultsDir).filter((f) => /^TEST-.*ScreenshotTest\.xml$/.test(f));
} catch {
  console.error(`weigh-screenshot-shards: no results at ${resultsDir}`);
  console.error("Run: ./gradlew :app:verifyRoborazziDebug --tests '*ScreenshotTest' --continue");
  process.exit(1);
}

if (files.length === 0) {
  console.error("weigh-screenshot-shards: the results directory holds no *ScreenshotTest XML.");
  console.error("A run filtered to something else leaves the old files in place, so this is");
  console.error("refusing rather than writing a weights file from a stale directory.");
  process.exit(1);
}

const measured = {};
for (const file of files) {
  const xml = readFileSync(join(resultsDir, file), "utf8");
  // <testsuite name="com.foo.BarScreenshotTest" tests="9" ... time="31.417">
  const name = /<testsuite[^>]*\bname="([^"]+)"/.exec(xml)?.[1];
  const time = /<testsuite[^>]*\btime="([0-9.]+)"/.exec(xml)?.[1];
  if (!name || !time) {
    console.error(`weigh-screenshot-shards: ${file} has no name/time on its testsuite element`);
    process.exit(1);
  }
  measured[name] = Math.round(Number(time) * 10) / 10;
}

let existing = {};
if (!replace) {
  try {
    existing = JSON.parse(readFileSync(weightsFile, "utf8")).seconds ?? {};
  } catch {
    existing = {};
  }
}

const seconds = { ...existing, ...measured };
const ordered = Object.fromEntries(Object.keys(seconds).sort().map((k) => [k, seconds[k]]));
const total = Object.values(ordered).reduce((a, b) => a + b, 0);

writeFileSync(
  weightsFile,
  `${JSON.stringify(
    {
      _comment:
        "US-3121. Seconds each screenshot class took to render and compare, from a real run. "
        + "Read by scripts/plan-screenshot-shards.mjs to balance the CI shards. Regenerate with "
        + "`node scripts/weigh-screenshot-shards.mjs` after a full run. Relative values are what matter, "
        + "so a developer machine is a fine place to measure. A missing class is budgeted at the "
        + "maximum rather than at zero, so a stale file loses balance and never loses coverage.",
      measuredAt: new Date().toISOString().slice(0, 10),
      seconds: ordered,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `weigh-screenshot-shards: wrote ${Object.keys(measured).length} measured `
  + `(${Object.keys(ordered).length} total, ${(total / 60).toFixed(1)} class-minutes) to `
  + "scripts/screenshot-shard-weights.json",
);
const slowest = Object.entries(measured).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log("\nslowest ten:");
for (const [cls, s] of slowest) {
  console.log(`  ${String(s).padStart(7)}s  ${cls.replace(/^.*\./, "")}`);
}
