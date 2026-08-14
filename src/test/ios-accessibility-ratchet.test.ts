import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// US-2534. Eight iOS screens carry no accessibility labels at all, including a
// 505-line drag-to-reorder photo manager — a control that is not merely awkward
// without sight but impossible.
//
// The labels themselves are Swift and cannot be compiled or run from this
// Windows checkout. What CAN be built here is the instrument: a shrink-only
// ratchet over the whole iOS tree, so the eight are named as debt, the 68 files
// that DO carry labels cannot silently lose them, and the fix — whenever it is
// written — is measurable rather than asserted.
//
// The repo's own iOS guards (ios/Scripts/no-ungated-print.py and friends) are
// Python and run on the macOS lane. This one is TypeScript in the web suite,
// following ios-aspect-registry-parity.test.ts, precisely so it runs on the
// machine the work is being done from.

const IOS_ROOT = "ios";

function swiftFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(resolve(process.cwd(), dir))) {
    const rel = join(dir, entry);
    if (statSync(resolve(process.cwd(), rel)).isDirectory()) swiftFiles(rel, out);
    else if (entry.endsWith(".swift")) out.push(rel.split("\\").join("/"));
  }
  return out;
}

function labelCount(rel: string): number {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  return (src.match(/\.accessibilityLabel\s*\(/g) ?? []).length;
}

/**
 * The eight screens US-2534 names, at their REAL paths.
 *
 * The story lists AIExtractView.swift under Analytics/; it actually lives in
 * AIExtract/. Recorded here rather than silently corrected, because a story
 * that names a path nobody can find is how an audit item gets closed as
 * "not applicable".
 */
const TARGET_SCREENS = [
  "ios/GradeThread/Inventory/ItemCanvas/Photos/PhotoManagerView.swift",
  "ios/GradeThread/Marketplaces/ListingKit/ListingKitView.swift",
  "ios/GradeThread/Measure/MeasurementPhotoEditorView.swift",
  "ios/GradeThread/AIExtract/AIExtractView.swift",
  "ios/GradeThread/Inventory/GlobalSearchView.swift",
  "ios/GradeThread/Scout/ScoutView.swift",
  "ios/GradeThread/Sales/SalesView.swift",
  "ios/GradeThread/Fulfillment/FulfillmentView.swift",
] as const;

describe("the eight named screens (US-2534 AC1/AC3)", () => {
  it("all eight exist at the paths this guard watches", () => {
    // A guard pointing at a moved file passes forever and protects nothing.
    for (const rel of TARGET_SCREENS) {
      expect(() => readFileSync(resolve(process.cwd(), rel), "utf8"), rel)
        .not.toThrow();
    }
  });

  it("their label count only ever goes UP", () => {
    // Each is 0 today, which is what AC1 and AC3 assert. This is deliberately
    // a floor, not an equality: the point of the story is to RAISE these, and a
    // guard that failed when someone did the work would be worse than none.
    const FLOOR: Record<string, number> = Object.fromEntries(
      TARGET_SCREENS.map((rel) => [rel, 0]),
    );
    const regressions: string[] = [];
    for (const rel of TARGET_SCREENS) {
      const n = labelCount(rel);
      if (n < FLOOR[rel]!) regressions.push(`${rel}: ${n} < ${FLOOR[rel]}`);
    }
    expect(regressions).toEqual([]);
  });

  it("the photo manager is still the sharpest case", () => {
    // 505 lines of drag-to-reorder. AC2 asks for move-up / move-down actions as
    // the accessible alternative, because a drag gesture has no VoiceOver
    // equivalent — this is the one screen where the gap is impossibility, not
    // inconvenience.
    const rel = "ios/GradeThread/Inventory/ItemCanvas/Photos/PhotoManagerView.swift";
    const src = readFileSync(resolve(process.cwd(), rel), "utf8");
    expect(src).toMatch(/onMove|DragGesture|draggable|onDrag/);
    if (labelCount(rel) > 0) {
      // Once labels land here, the reorder alternative must land with them.
      expect(
        /accessibilityAction|move up|move down/i.test(src),
        "PhotoManagerView gained labels but no accessible reorder alternative " +
          "— a labelled drag handle is still undraggable with VoiceOver",
      ).toBe(true);
    }
  });
});

describe("the rest of the app cannot regress (US-2534)", () => {
  // 68 files carry 171 label CALL SITES today. Those are the ones a refactor
  // can quietly strip, and nothing was watching them.
  //
  // 171, not 185: a bare grep for the word also counts helper declarations
  // (`private var accessibilityLabel: String`, `func accessibilityLabel(for:)`)
  // and one `.accessibilityHidden(accessibilityLabel == nil)`. Those are not
  // labels applied to a control, so the regex requires the leading dot and the
  // open paren. Counting the word would inflate the baseline by 14 and let 14
  // real labels be deleted without tripping this.
  const BASELINE_FILES_WITH_LABELS = 68;
  const BASELINE_TOTAL_LABELS = 171;

  it("no fewer files carry labels than today", () => {
    const withLabels = swiftFiles(IOS_ROOT).filter((f) => labelCount(f) > 0);
    expect(
      withLabels.length,
      `${withLabels.length} files carry accessibility labels, was ` +
        `${BASELINE_FILES_WITH_LABELS}. If a file was deleted or renamed, lower ` +
        "the baseline in the same commit; if labels were stripped, put them back.",
    ).toBeGreaterThanOrEqual(BASELINE_FILES_WITH_LABELS);
  });

  it("no fewer labels in total than today", () => {
    const total = swiftFiles(IOS_ROOT).reduce((n, f) => n + labelCount(f), 0);
    expect(
      total,
      `${total} accessibility labels across the iOS tree, was ` +
        `${BASELINE_TOTAL_LABELS}. This is a floor — raising it is the goal.`,
    ).toBeGreaterThanOrEqual(BASELINE_TOTAL_LABELS);
  });

  it("the well-covered screens keep their labels", () => {
    // Naming the leaders individually so a regression points at a file rather
    // than at a number that moved.
    const PINNED: Record<string, number> = {
      "ios/GradeThread/ContentView.swift": 11,
      "ios/GradeThread/AutoLister/AutoListerView.swift": 11,
      "ios/GradeThread/Marketplaces/Publish/PublishDialog.swift": 10,
    };
    for (const [rel, floor] of Object.entries(PINNED)) {
      expect(labelCount(rel), `${rel} lost accessibility labels`)
        .toBeGreaterThanOrEqual(floor);
    }
  });
});

describe("what this slice does NOT claim (US-2534)", () => {
  it("the eight screens are not asserted to be fixed", () => {
    // AC2 is Swift. This guard measures the debt and stops it growing; it does
    // not pretend the labels exist. When they land, the floors above rise with
    // them in the same commit.
    const stillZero = TARGET_SCREENS.filter((rel) => labelCount(rel) === 0);
    const tracker = readFileSync(
      resolve(process.cwd(), "docs/reviews/full-surface-2026-08/FIX-PROGRESS.md"),
      "utf8",
    );
    if (stillZero.length > 0) {
      expect(tracker).toContain("US-2534");
    }
  });
});
