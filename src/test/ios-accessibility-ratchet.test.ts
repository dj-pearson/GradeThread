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

describe("the measurement canvas can be operated without a drag (US-2534 AC2)", () => {
  // The last gap on this story, and the only one on these screens that a LABEL
  // could never have closed. MeasurementPhotoEditorView positions endpoints with
  // a DragGesture on a bare Canvas: VoiceOver has no handle on it, Switch
  // Control has nothing to select, full keyboard access has nothing to focus.
  // The missing thing was not a name, it was a way to perform the action.

  const EDITOR = "ios/GradeThread/Measure/MeasurementPhotoEditorView.swift";
  const NUDGE = "ios/GradeThread/Measure/MeasureNudge.swift";

  const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

  /** Comments stripped: a paragraph about a control is not a control. */
  const code = (rel: string) =>
    src(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("the drag is still there, so this is an ALTERNATIVE and not a replacement", () => {
    // Taking the drag away would "fix" the accessibility gap by making the
    // screen worse for everyone who was already using it.
    expect(code(EDITOR)).toContain("DragGesture(");
  });

  it("every endpoint has four real Buttons, not one adjustable action", () => {
    // An accessibilityAdjustableAction gives ONE increment axis for the whole
    // canvas. An endpoint needs two axes and a choice of which endpoint moves,
    // and an action stays invisible to Switch Control, which needs a control.
    const editor = code(EDITOR);
    expect(editor).toContain("MeasureNudge.Direction.allCases");
    expect(editor).toContain("endpointRow(index: index, end: .e1");
    expect(editor).toContain("endpointRow(index: index, end: .e2");
  });

  it("a nudged line is marked touched, exactly like a dragged one", () => {
    // Without this the accessible path silently saves nothing and logs no
    // correction delta - a second-class route that looks like it worked.
    const editor = code(EDITOR);
    const start = editor.indexOf("private func nudge(");
    expect(start, "the nudge action vanished").toBeGreaterThan(-1);
    const block = editor.slice(start, start + 1400);
    expect(block).toContain("touched.insert(");
  });

  it("the step is never zero and never keyed on width alone", () => {
    // A zero step is a button that reports success and moves nothing. Keying on
    // width would make a tall photo four times coarser than a wide one.
    const nudge = code(NUDGE);
    expect(nudge).toContain("min(imgW, imgH)");
    expect(nudge).toMatch(/max\(1,/);
  });

  it("the announcement speaks inches, not pixel coordinates", () => {
    // "x 1284, y 902" is a true statement about nothing a seller can act on.
    //
    // Scoped to the announcement FUNCTION. The first version scanned the whole
    // file and failed on `nudged`, which reads point.x and point.y because
    // moving a point is what it does - a guard that forbids the maths in order
    // to forbid saying the maths out loud.
    const nudge = code(NUDGE);
    expect(nudge).toContain("MeasureGeometry.formatQuarter(inches)");
    const start = nudge.indexOf("static func announcement(");
    expect(start, "the announcement helper vanished").toBeGreaterThan(-1);
    const block = nudge.slice(start);
    expect(block).not.toMatch(/point\.x|point\.y|x:|y:/);
  });

  it("the nudge maths is NOT in the file that claims to mirror the web", () => {
    // MeasureGeometry.swift states in its own header that it is a port of
    // src/lib/measure-editor-math.ts and that both suites assert the same cases.
    // Adding a Swift-only function there would make that sentence false while
    // every test still passed.
    const geometry = code("ios/GradeThread/Measure/MeasureGeometry.swift");
    expect(geometry).not.toContain("nudge");
    expect(() => src(NUDGE)).not.toThrow();
  });
});
