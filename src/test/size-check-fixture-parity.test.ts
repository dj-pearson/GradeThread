import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2920/US-2921: the size check exists in four copies — the edge module, the
// browser module, Swift and Kotlin — because edge code cannot import from src/
// and neither phone can import either. Four copies of one rule stay one rule
// only while they answer the same questions with the same numbers.
//
// Each suite runs the two fixture cases in its own language, which is what
// actually proves the behaviour. This guard proves they are the SAME two cases:
// it reads all four test files and fails if any of them stops carrying the
// numbers. A copy that quietly drops a case still passes its own suite, and
// that is the failure mode nobody notices.
//
// It checks the INPUTS and the OUTPUTS of the two fixtures, not the assertions
// around them — a suite is free to phrase its assertions however its language
// prefers, and none of them may change what the answer is.

const ROOT = process.cwd();

const SUITES: Array<[label: string, path: string]> = [
  ["edge", "services/edge-functions/src/tests/size-check_test.ts"],
  ["web", "src/lib/size-check.test.ts"],
  ["iOS", "ios/GradeThreadTests/SizeCheckTests.swift"],
  [
    "Android",
    "android/app/src/test/java/com/gradethread/app/inventory/SizeCheckTest.kt",
  ],
];

/**
 * Every value the two fixture cases are made of.
 *
 * THE MOTIVATING CASE: a Lululemon men's top measuring 17.5 in flat, labelled
 * Large, against a chart whose Large is a 22-26.5 in flat garment. It must fire
 * and name an implied size below the smallest the brand makes.
 *
 * THE NO-FALSE-ALARM CASE: an ordinary tee measuring 22 in flat, labelled L, on
 * the generic chart whose Large is exactly 22-26.5 in. It must stay quiet.
 */
const FIXTURE_FACTS: Array<[what: string, needle: RegExp]> = [
  ["the mislabelled 17.5 in chest", /17\.5/],
  ["the Large it is labelled", /"Large"/],
  ["the implied size below the chart", /smaller than XS/],
  ["the Large band, 22 to 26.5 in flat", /22(\.0)?\s*,\s*26\.5|22 to 26\.5/],
  ["the correctly sized 22 in chest", /\b22\b/],
  ["the generic tier the quiet case runs on", /"generic"/],
];

describe("the size check's fixture cases are the same in all four copies", () => {
  const present = SUITES.filter(([, path]) => existsSync(resolve(ROOT, path)));

  it("finds every suite", () => {
    const missing = SUITES.filter(([, p]) => !existsSync(resolve(ROOT, p))).map(
      ([label]) => label,
    );
    expect(
      missing,
      `these size-check suites are missing, so their copy of the rule is ` +
        `unchecked: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it.each(present)("%s carries every fixture value", (_label, path) => {
    const src = readFileSync(resolve(ROOT, path), "utf8");
    const absent = FIXTURE_FACTS.filter(([, needle]) => !needle.test(src)).map(
      ([what]) => what,
    );
    expect(
      absent,
      `${path} no longer carries: ${absent.join("; ")}. Either the fixture ` +
        `changed in one copy only, or a case was dropped — both mean the four ` +
        `implementations have stopped agreeing.`,
    ).toEqual([]);
  });

  it("every suite pins the tolerance rule: one step on a real chart, two on a generic one", () => {
    for (const [label, path] of present) {
      const src = readFileSync(resolve(ROOT, path), "utf8");
      expect(src, `${label} does not pin the verified/brand tolerance`).toMatch(
        /"verified"/,
      );
      expect(src, `${label} does not pin the generic tolerance`).toMatch(/"generic"/);
    }
  });
});
