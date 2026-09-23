import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_TARGET, FLOOR, checkFloor, targetCoverage } from "../../scripts/ios-coverage-floor.mjs";

// Mobile plan action 6: the iOS coverage floor. The script runs only on a
// macOS runner, so its arithmetic and its wiring are pinned here instead.

/** The shape `xcrun xccov view --report --json` prints, trimmed. */
function report(appCovered: number, appExecutable: number) {
  return {
    coveredLines: 999_999,
    executableLines: 1_000_000,
    lineCoverage: 0.999,
    targets: [
      // A test bundle at 100% must not pad the app figure.
      { name: "GradeThreadTests.xctest", coveredLines: 50_000, executableLines: 50_000 },
      { name: APP_TARGET, coveredLines: appCovered, executableLines: appExecutable },
      { name: "GradeThreadCore", coveredLines: 900, executableLines: 1_000 },
    ],
  };
}

describe("ios coverage floor", () => {
  it("reads the app target only", () => {
    expect(targetCoverage(report(250, 1_000)).percent).toBeCloseTo(25, 5);
  });

  it("passes at or above the floor and fails below it", () => {
    expect(checkFloor(report(FLOOR * 10, 1_000)).ok).toBe(true);
    expect(checkFloor(report(FLOOR * 10 - 1, 1_000)).ok).toBe(false);
    expect(checkFloor(report(0, 1_000)).line).toContain(`floor ${FLOOR}%`);
  });

  it("fails loudly when the app target is missing or never ran", () => {
    expect(() => targetCoverage({ targets: [{ name: "Other.app", coveredLines: 1, executableLines: 2 }] })).toThrow(
      /no target named GradeThread\.app/,
    );
    expect(() => targetCoverage({ targets: [{ name: APP_TARGET, coveredLines: 0, executableLines: 0 }] })).toThrow(
      /did not run/,
    );
  });

  it("iOS CI writes a result bundle and runs the floor against it", () => {
    const wf = readFileSync(resolve(process.cwd(), ".github/workflows/ios-ci.yml"), "utf8");
    expect(wf).toContain("-resultBundlePath build/TestResults.xcresult");
    expect(wf).toContain("xcrun xccov view --report --json build/TestResults.xcresult > build/coverage.json");
    expect(wf).toContain("node ../scripts/ios-coverage-floor.mjs build/coverage.json");
    expect(wf).toMatch(/-enableCodeCoverage YES/);
  });
});
