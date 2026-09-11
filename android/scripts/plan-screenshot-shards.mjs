#!/usr/bin/env node
// US-3121: decide WHICH screenshot classes each CI shard renders.
//
// THE PROBLEM THIS REPLACES. android-ci.yml used to split the classes with
// `awk NR % 4`, which is a complete partition and a terrible schedule. A shard's
// wall clock is set by how long its classes take to RENDER, and that has almost
// nothing to do with how many of them there are:
//
//   run 34223941706, 2026-09-08, the first run whose shards actually rendered
//     shard 0   13 classes,  76 tests   13m54s
//     shard 1   14 classes, 105 tests   35m28s
//     shard 2   14 classes, 105 tests   19m08s
//     shard 3   14 classes, 109 tests   killed at the 45-minute ceiling
//
// Shards 1 and 2 had the SAME test count and one took 1.9x the other. Run
// 34052016341 the day before put the ceiling on the same two shards, 1 and 3,
// so this is a property of the classes and not runner noise. Counting classes,
// or counting @Test methods, cannot see it.
//
// WHAT THIS DOES INSTEAD. `screenshot-shard-weights.json` holds a measured
// second-count per class. This sorts by that, longest first, and drops each
// class into whichever shard is currently lightest (LPT - the standard greedy
// makespan schedule, which is provably within 4/3 of optimal). The result is
// deterministic: the same tree gives the same shards on every runner.
//
// THE WEIGHTS ARE A HINT, NEVER A GATE. A class with no entry - a screenshot
// test written after the last measurement - gets the heaviest known weight, so
// it lands in the emptiest shard and is over-budgeted rather than under. Nothing
// here fails because the file is stale; a stale file degrades the balance, and
// the workflow prints predicted-vs-actual so the drift is visible. A partition
// that refuses to run because a JSON is out of date would be a worse failure
// than the one it is preventing.
//
// WHAT IT DOES REFUSE. An empty shard, and a class landing in two shards or
// none. Those are the failures that look like success: four green shards that
// rendered nothing at all is exactly what a broken glob produces.
//
// Usage:
//   node scripts/plan-screenshot-shards.mjs --of 4 --shard 3   # class names
//   node scripts/plan-screenshot-shards.mjs --of 4 --plan      # the table
//   node scripts/plan-screenshot-shards.mjs --self-test        # prove the maths

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const androidDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(androidDir, "app/src/test");
const weightsFile = join(androidDir, "scripts/screenshot-shard-weights.json");

/** Every *ScreenshotTest.kt under app/src/test, as a fully qualified class. */
export function discoverClasses(root = testRoot) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith("ScreenshotTest.kt")) {
        // .../app/src/test/java/com/gradethread/app/ui/HomeScreenshotTest.kt
        //                       ^ everything after /java/ is the package path
        const rel = path.replace(/\\/g, "/").split("/java/")[1];
        if (rel) out.push(rel.replace(/\.kt$/, "").replace(/\//g, "."));
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * LPT: heaviest class first, each into the lightest shard so far.
 *
 * Ties break on the class name, so the plan is identical on every machine -
 * a shard that renders a different set than the run before it would make the
 * predicted/actual line below meaningless.
 */
export function planShards(classes, weights, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`shard count must be a positive integer, got ${shardCount}`);
  }
  const known = Object.values(weights).filter((n) => typeof n === "number" && n > 0);
  // Pessimistic default: an unmeasured class is assumed to be the worst one we
  // know about. Over-budgeting a new test costs a few minutes on one shard;
  // under-budgeting it is how a shard silently grows past the timeout again.
  const fallback = known.length ? Math.max(...known) : 1;

  const ordered = [...classes].sort((a, b) => {
    const wa = weights[a] ?? fallback;
    const wb = weights[b] ?? fallback;
    return wb - wa || a.localeCompare(b);
  });

  const shards = Array.from({ length: shardCount }, () => ({ classes: [], seconds: 0 }));
  for (const cls of ordered) {
    let lightest = shards[0];
    for (const shard of shards) {
      if (shard.seconds < lightest.seconds) lightest = shard;
    }
    lightest.classes.push(cls);
    lightest.seconds += weights[cls] ?? fallback;
  }
  for (const shard of shards) shard.classes.sort();
  return shards;
}

/**
 * How many test JVMs a runner gets. app/build.gradle.kts sets
 * `maxParallelForks = availableProcessors().coerceAtMost(4)`, and a
 * GitHub-hosted ubuntu-latest runner has four cores, so four.
 *
 * This exists because the SUM of a shard's class times is the wrong number to
 * read: Gradle hands whole classes to forks, so four classes of ten minutes
 * each is a ten-minute shard and one class of forty minutes is a forty-minute
 * shard. Only the second kind is a problem, and only the makespan tells them
 * apart.
 */
const FORKS = 4;

/** LPT again, one level down: the finishing time of the busiest fork. */
export function makespan(costs, forks) {
  const busy = new Array(forks).fill(0);
  for (const cost of [...costs].sort((a, b) => b - a)) {
    let least = 0;
    for (let i = 1; i < forks; i++) if (busy[i] < busy[least]) least = i;
    busy[least] += cost;
  }
  return Math.max(...busy, 0);
}

function loadWeights() {
  try {
    const parsed = JSON.parse(readFileSync(weightsFile, "utf8"));
    return parsed.seconds ?? {};
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------- self-test
// The three ways this file can be wrong all read as a normal run: a class in
// two shards renders twice and proves nothing extra, a class in none is an
// assertion that silently stopped existing, and an empty shard is a green job
// that did no work.
function selfTest() {
  const fail = (msg) => {
    console.error(`plan-screenshot-shards --self-test: ${msg}`);
    process.exitCode = 1;
  };

  const synthetic = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`c${i}`, (i % 7) + 1]),
  );
  const names = Object.keys(synthetic);

  for (const n of [1, 2, 3, 4, 8, 13]) {
    const shards = planShards(names, synthetic, n);
    const flat = shards.flatMap((s) => s.classes);
    if (flat.length !== names.length) fail(`${n} shards: ${flat.length} placements for ${names.length} classes`);
    if (new Set(flat).size !== names.length) fail(`${n} shards: a class landed in more than one`);
    if (shards.some((s) => s.classes.length === 0)) fail(`${n} shards: one is empty`);
  }

  // The point of LPT over round-robin: it must beat the naive split on a set
  // where cost and count disagree. One class costing 100 and 30 costing 1.
  const lopsided = { heavy: 100, ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`l${i}`, 1])) };
  const balanced = planShards(Object.keys(lopsided), lopsided, 4);
  const worst = Math.max(...balanced.map((s) => s.seconds));
  if (worst > 105) fail(`LPT left a ${worst}s shard where 100s is the floor`);

  // An unmeasured class must be treated as the heaviest, not as free.
  const withNew = planShards(["heavy", "brandNew"], { heavy: 100 }, 2);
  if (withNew.some((s) => s.seconds < 100)) fail("an unweighted class was budgeted at less than the known maximum");

  // makespan must report the WALL, not the sum: four ten-minute classes on four
  // forks is ten minutes, and one forty-minute class is forty however many
  // forks there are. Reading the sum instead is what made a 40-minute shard
  // look like the same size as four 10-minute ones.
  if (makespan([600, 600, 600, 600], 4) !== 600) fail("makespan is summing classes that run in parallel");
  if (makespan([2400], 4) !== 2400) fail("makespan thinks a single class can use more than one fork");
  if (makespan([], 4) !== 0) fail("makespan of nothing is not zero");

  // Deterministic: the same inputs must give byte-identical shards.
  const a = JSON.stringify(planShards(names, synthetic, 5));
  const b = JSON.stringify(planShards([...names].reverse(), synthetic, 5));
  if (a !== b) fail("the plan depends on input order");

  if (!process.exitCode) console.log("plan-screenshot-shards --self-test: OK");
}

// ----------------------------------------------------------------------- main
// Guarded so the two functions above can be imported by a test without the CLI
// running and calling process.exit on it.
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const args = invokedDirectly ? process.argv.slice(2) : ["--noop"];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

if (!invokedDirectly) {
  // imported: expose planShards/discoverClasses and do nothing else
} else if (args.includes("--self-test")) {
  selfTest();
} else {
  const total = Number(flag("of") ?? 0);
  const classes = discoverClasses();
  const weights = loadWeights();

  if (classes.length === 0) {
    console.error("plan-screenshot-shards: found no *ScreenshotTest.kt under app/src/test");
    process.exit(1);
  }
  if (!Number.isInteger(total) || total < 1 || total > classes.length) {
    console.error(`plan-screenshot-shards: --of must be 1..${classes.length}, got ${flag("of")}`);
    process.exit(1);
  }

  const shards = planShards(classes, weights, total);

  if (args.includes("--plan")) {
    const unweighted = classes.filter((c) => weights[c] === undefined);
    console.log(`${classes.length} screenshot classes over ${total} shards`);
    console.log("  (wall = the makespan over 4 forks; a class never splits across two)");
    for (const [i, shard] of shards.entries()) {
      const mins = (shard.seconds / 60).toFixed(1);
      const wall = (makespan(shard.classes.map((c) => weights[c] ?? 0), FORKS) / 60).toFixed(1);
      console.log(
        `  shard ${i}: ${String(shard.classes.length).padStart(2)} classes, `
        + `${mins} class-min, ~${wall} min wall`,
      );
    }
    if (unweighted.length) {
      console.log(`\n${unweighted.length} class(es) have no measured weight and were budgeted at the maximum:`);
      for (const c of unweighted) console.log(`  ${c}`);
      console.log("Re-measure with: node scripts/weigh-screenshot-shards.mjs after a full run");
    }
    const stale = Object.keys(weights).filter((c) => !classes.includes(c));
    if (stale.length) {
      console.log(`\n${stale.length} weight(s) name a class that no longer exists: ${stale.join(", ")}`);
    }
  } else {
    const index = Number(flag("shard"));
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      console.error(`plan-screenshot-shards: --shard must be 0..${total - 1}, got ${flag("shard")}`);
      process.exit(1);
    }
    const mine = shards[index];
    if (mine.classes.length === 0) {
      console.error(`plan-screenshot-shards: shard ${index} of ${total} is empty`);
      process.exit(1);
    }
    for (const cls of mine.classes) console.log(cls);
  }
}
