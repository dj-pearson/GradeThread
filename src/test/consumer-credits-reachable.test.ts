import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2830 AC6: the out-of-credits state must offer a way to pay.
//
// WHY THIS IS A TEST AND NOT A FIX. It shipped that way on BOTH phones and
// nothing noticed for months: `ConsumerGradeFlow` carried `creditsPurchased`,
// `recheckCredits`, and the `awaitingCredits` / `creditsDelayed` states with
// written copy, and not one of them had a caller. The flow quoted a pack size
// and offered no control of any kind — after the seller had chosen a garment,
// filled in its details, taken every photo and waited out an upload.
//
// Every part of that is easy to reintroduce. Deleting a sheet from one branch
// of a `when`/`switch` leaves the notice behind and looks tidy in a diff, and
// the tests for the flow itself stay green because the flow was never the
// broken half.
//
// ⚠ ASSERTIONS ARE SCOPED TO THE BRANCH, not the file. A file-wide `toContain`
// would pass on any mention anywhere — including the import line, or the other
// state's handler. That exact mistake has been made five times in this repo
// this month, so the branch is sliced out and searched on its own.

const ANDROID_SCREEN =
  "android/app/src/main/java/com/gradethread/app/grading/ConsumerGradeScreen.kt";
const IOS_PROGRESS = "ios/GradeThread/Grading/ConsumerGradeProgressView.swift";
const ANDROID_VM =
  "android/app/src/main/java/com/gradethread/app/grading/ConsumerGradeViewModel.kt";
const IOS_VIEW = "ios/GradeThread/Grading/ConsumerGradeView.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8").split("\r\n").join("\n");
}

/** The text between `from` and the next `until` marker after it. */
function branch(src: string, from: string, until: RegExp): string {
  const start = src.indexOf(from);
  expect(start, `branch marker missing: ${from}`).toBeGreaterThan(-1);
  const rest = src.slice(start + from.length);
  const m = until.exec(rest);
  return rest.slice(0, m ? m.index : rest.length);
}

describe("US-2830: running out of grades offers a way to buy them", () => {
  it("Android's out-of-credits branch mounts the pack sheet", () => {
    const body = branch(
      read(ANDROID_SCREEN),
      "is ConsumerGradeFlow.Step.NeedsCredits ->",
      /is ConsumerGradeFlow\.Step\./,
    );
    expect(
      body,
      "the NeedsCredits branch quotes a price with no control — which is the " +
        "state this story exists to remove",
    ).toContain("ConsumerCreditPackSheet");
  });

  it("iOS's out-of-credits branch offers the purchase", () => {
    const body = branch(
      read(IOS_PROGRESS),
      "case .needsCredits(",
      /\n {12}case \./,
    );
    expect(body, "the needsCredits case has no purchase control").toContain("buyingFor");
  });

  it("iOS mounts the pack sheet, and exactly once", () => {
    const src = read(IOS_PROGRESS);
    expect(src).toContain("CreditPackSheet(userId:");
    // ONE sheet on this view. Two `.sheet` modifiers compete and the loser
    // opens and closes in the same frame; ios/Scripts/check-chained-sheets.py
    // enforces it, and this states the reason the sheet lives HERE rather than
    // on ConsumerGradeView, which already spends its slot on the photo picker.
    expect(src.split(".sheet(").length - 1, "a second sheet on this view").toBe(1);
  });

  it("the delayed state can be re-checked on both phones", () => {
    // `creditsDelayed` tells the seller their purchase went through and to wait.
    // Until this story there was nothing to wait WITH: a grant that missed the
    // poll window left them on a dead screen holding a receipt.
    const android = branch(
      read(ANDROID_SCREEN),
      "is ConsumerGradeFlow.Step.CreditsDelayed ->",
      /is ConsumerGradeFlow\.Step\./,
    );
    expect(android, "Android's delayed state has no check-again").toContain("onRecheck");

    const ios = branch(read(IOS_PROGRESS), "case .creditsDelayed(", /\n {12}case \./);
    expect(ios, "iOS's delayed state has no check-again").toContain("onRecheck");
  });

  it("both view layers actually call the flow's credit functions", () => {
    // The functions existed the whole time. What was missing was a caller, so
    // that is what is asserted — not their existence.
    expect(read(ANDROID_VM)).toContain("flow.creditsPurchased(");
    expect(read(ANDROID_VM)).toContain("flow.recheckCredits(");
    const ios = read(IOS_VIEW);
    expect(ios).toContain("flow.creditsPurchased(");
    expect(ios).toContain("flow.recheckCredits(");
  });

  it("neither client decides the submission is paid", () => {
    // The one property that must not drift. `POST /api/grade/pay/:id` is
    // idempotent per submission (US-2298), so asking it again after a purchase
    // is safe and is the ONLY thing that settles this. A client that flipped
    // itself to `grading` on a successful purchase would show a grade in
    // progress that nobody is paying for.
    for (const rel of [ANDROID_VM, IOS_VIEW]) {
      const src = read(rel);
      expect(src, `${rel} sets a terminal step from a purchase`).not.toMatch(
        /purchase[^\n]*(Step\.Grading|\.grading\()/i,
      );
    }
  });
});
