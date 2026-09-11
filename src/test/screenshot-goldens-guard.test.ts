import { describe, expect, it } from "vitest";

// US-3311. The guard lives in scripts/check-screenshot-goldens.mjs; this is the
// vitest half, so the rules ride verify:web and the frontend CI job as well as
// the two lanes the script is named in.
//
// THREE SEPARATE THINGS ARE HELD HERE, and they fail for different reasons:
//   1. the tree is clean - no infinite animation in Android app code that a
//      capture cannot freeze, and no golden that no test names;
//   2. the SCAN still detects - selfCheckProblems() runs both rules against
//      fixtures each one has to trip, because a rule that has quietly stopped
//      matching reports a clean tree and that is precisely how thirteen
//      unrenderable goldens sat in the suite for eleven days;
//   3. the corpus is still the corpus - a walk that finds nothing produces an
//      empty findings list, which is byte-identical to success.
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM. Neither rule renders anything, so
// neither can tell you whether a golden still matches its screen. That question
// belongs to verifyRoborazziDebug and to nothing else. A commit-order stand-in
// (golden older than the screen it covers) was measured on this tree on
// 2026-09-11 and called 252 of 395 stale the day after the suite went green,
// because US-3311 touched 26 screen files and only 47 goldens moved a pixel.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain ESM script, no types
import { SELF_CHECK_CASES, goldenNamesIn, run, selfCheckProblems } from "../../scripts/check-screenshot-goldens.mjs";

describe("Android screenshot goldens (US-3311)", () => {
  it("still detects every offence it was written for", () => {
    const fails: string[] = selfCheckProblems();
    expect(
      fails,
      "the scan stopped recognising an offence it used to catch, which reads " +
        "exactly like a clean tree",
    ).toEqual([]);
    expect(SELF_CHECK_CASES, "the self-test shrank").toBeGreaterThanOrEqual(13);
  });

  it("read the whole corpus, so a clean result means something", () => {
    const { skipped, mainSources, tests, goldens } = run();
    expect(skipped, "the android/ screenshot tree moved").toBe(false);
    expect(mainSources).toBeGreaterThan(200);
    expect(tests).toBeGreaterThan(40);
    expect(goldens).toBeGreaterThan(200);
  });

  it("finds no unfreezable animation and no unnamed golden", () => {
    const { problems } = run();
    expect(
      problems,
      "An infinite animation in app code hangs every capture that reaches it - " +
        "thirteen goldens were 93 percent of a two-hour suite and all thirteen " +
        "failed. A golden no test names can never fail at all. Both are " +
        "invisible to Gradle, to detekt and to review.",
    ).toEqual([]);
  });

  it("reports an unreadable capture shape instead of returning no names", () => {
    // The costly direction. If a class starts capturing some other way the scan
    // goes blind, and a blind scan says the tree is clean.
    const { names, problems } = goldenNamesIn(
      "Odd.kt",
      'captureRoboImage("src/test/screenshots/screen-odd-light.png") { Odd() }',
    );
    expect(names).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("cannot be checked");
  });
});
