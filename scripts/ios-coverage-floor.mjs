#!/usr/bin/env node
// iOS line-coverage floor (mobile plan action 6).
//
// iOS CI has gathered coverage for months (`-enableCodeCoverage YES` in
// ios-ci.yml, `gatherCoverageData: true` in project.yml) and nothing read the
// number, so deleting half the unit tests would have stayed green. Android has
// enforced a measured floor with kover since US-2344; this is the iOS half.
//
// Usage (on the macOS runner, after `xcodebuild test -resultBundlePath ...`):
//   xcrun xccov view --report --json build/TestResults.xcresult > build/coverage.json
//   node scripts/ios-coverage-floor.mjs build/coverage.json
//
// The floor is on the APP target only (`GradeThread.app`). The report also
// lists the test bundle, the extensions and the SwiftPM packages; folding
// those in would let a test file's own lines pad the number.
//
// FLOOR IS NOT MEASURED YET. No Mac and no xcresult were reachable when this
// was written, so 5 is a placeholder low enough that it cannot fail a healthy
// run and high enough to catch the suite not running at all. The first green
// run prints the real figure; raise FLOOR to that number rounded DOWN to a
// multiple of 5, exactly as android/app/build.gradle.kts did with 46.16 -> 45.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FLOOR = 5;
export const APP_TARGET = "GradeThread.app";

/**
 * Line coverage of one target in an `xccov view --report --json` document,
 * as a percentage. Computed from covered/executable lines rather than trusting
 * `lineCoverage`, so an empty target reads 0 instead of NaN.
 */
export function targetCoverage(report, name = APP_TARGET) {
  const targets = Array.isArray(report?.targets) ? report.targets : [];
  const target = targets.find((t) => t?.name === name);
  if (!target) {
    const seen = targets.map((t) => t?.name).join(", ") || "none";
    throw new Error(`no target named ${name} in the coverage report (targets: ${seen})`);
  }
  const covered = Number(target.coveredLines ?? 0);
  const executable = Number(target.executableLines ?? 0);
  if (!Number.isFinite(covered) || !Number.isFinite(executable) || executable <= 0) {
    throw new Error(`${name} reports ${executable} executable lines; the tests did not run against it`);
  }
  return { covered, executable, percent: (covered / executable) * 100 };
}

/** The verdict, as a line to print and whether it passes. */
export function checkFloor(report, floor = FLOOR, name = APP_TARGET) {
  const { covered, executable, percent } = targetCoverage(report, name);
  const line = `${name}: ${percent.toFixed(2)}% line coverage (${covered}/${executable}), floor ${floor}%`;
  return { ok: percent >= floor, percent, line };
}

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error("usage: node scripts/ios-coverage-floor.mjs <xccov-report.json>");
    return 2;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`could not read ${file}: ${err.message}`);
    return 2;
  }
  for (const t of Array.isArray(report?.targets) ? report.targets : []) {
    const pct = t.executableLines > 0 ? ((t.coveredLines / t.executableLines) * 100).toFixed(2) : "n/a";
    console.log(`  ${t.name}: ${pct}%`);
  }
  try {
    const { ok, line } = checkFloor(report);
    console.log(line);
    if (!ok) {
      console.error(`iOS line coverage fell below the ${FLOOR}% floor.`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv));
}
