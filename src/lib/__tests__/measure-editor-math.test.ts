// US-1574: the editor's pure math — px↔inch via the calibration homography,
// display-scale mapping, endpoint hit-testing, and default placements. These
// functions are the spec the iOS/Android editor ports mirror.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NUDGE_COARSE_MULTIPLE,
  type NudgeDirection,
  nudgeStep,
  nudged,
  applyHomography,
  defaultLinePlacement,
  fitScale,
  formatQuarter,
  hitEndpoint,
  inchesBetween,
  roundQuarterInch,
  type EditorLine,
} from "@/lib/measure-editor-math";
// US-1576: the SHARED behavioural fixture. The Android port asserts the same
// file, so the two cannot drift; a source diff could never be the guard,
// because the ports are in different languages with different point types.
import fixture from "../../test/fixtures/measure-editor-math-cases.json";

// 100 px per inch, pure scale.
const H = [1 / 100, 0, 0, 0, 1 / 100, 0, 0, 0, 1];

describe("measure-editor math", () => {
  it("maps px to inches through the homography", () => {
    expect(applyHomography(H, 250, 0)[0]).toBeCloseTo(2.5);
    expect(inchesBetween(H, [100, 500], [2300, 500])).toBe(22);
    expect(inchesBetween(H, [0, 0], [0, 2837])).toBe(28.25);
  });

  it("rounds and formats quarters", () => {
    expect(roundQuarterInch(22.13)).toBe(22.25);
    expect(formatQuarter(22.25)).toBe("22¼");
    expect(formatQuarter(28)).toBe("28");
    expect(formatQuarter(0.5)).toBe("½");
  });

  it("fitScale never upscales and fits both axes", () => {
    expect(fitScale(4000, 3000, 640, 480)).toBeCloseTo(0.16);
    expect(fitScale(300, 200, 640, 480)).toBe(1);
  });

  it("hitEndpoint grabs the nearest endpoint within radius, in display space", () => {
    const lines: EditorLine[] = [
      { key: "chest", label: "Chest", e1: [100, 100], e2: [500, 100] },
      { key: "length", label: "Length", e1: [300, 50], e2: [300, 450] },
    ];
    // Display scale 0.5: chest.e2 shows at (250, 50).
    expect(hitEndpoint(lines, [252, 52], 0.5)).toEqual({
      lineIndex: 0,
      end: "e2",
    });
    // Nothing within 14px.
    expect(hitEndpoint(lines, [400, 400], 0.5)).toBeNull();
    // length.e1 at (150, 25) beats chest endpoints for a point near it.
    expect(hitEndpoint(lines, [149, 27], 0.5)).toEqual({
      lineIndex: 1,
      end: "e1",
    });
  });

  it("default placements run vertical for length-like keys, horizontal otherwise", () => {
    const v = defaultLinePlacement("length", 1000, 800);
    expect(v.e1[0]).toBe(v.e2[0]); // vertical
    const h = defaultLinePlacement("chest", 1000, 800);
    expect(h.e1[1]).toBe(h.e2[1]); // horizontal
    expect(h.e2[0] - h.e1[0]).toBeCloseTo(400);
  });
});

// US-1576: every case below comes from the shared fixture rather than being
// written here, so adding a case constrains the Android port in the same
// commit. The web functions are the spec; this is what proves a port matches.
describe("shared fixture (web ↔ Android)", () => {
  const F = fixture as typeof fixture & { hitEndpoint: Array<{ radius: number }> };
  const h = F.homography;
  const TOL = F._tolerance;

  it("applyHomography", () => {
    for (const c of F.applyHomography) {
      const [x, y] = applyHomography(h, c.x, c.y);
      expect(x).toBeCloseTo(c.out[0]!, 9);
      expect(y).toBeCloseTo(c.out[1]!, 9);
    }
  });

  it("roundQuarterInch", () => {
    for (const c of F.roundQuarterInch) {
      expect(Math.abs(roundQuarterInch(c.in) - c.out)).toBeLessThan(TOL);
    }
  });

  it("formatQuarter", () => {
    for (const c of F.formatQuarter) expect(formatQuarter(c.in)).toBe(c.out);
  });

  it("fitScale", () => {
    for (const c of F.fitScale) {
      expect(Math.abs(fitScale(c.imgW, c.imgH, c.maxW, c.maxH) - c.out)).toBeLessThan(TOL);
    }
  });

  it("inchesBetween", () => {
    for (const c of F.inchesBetween) {
      const got = inchesBetween(h, c.e1 as [number, number], c.e2 as [number, number]);
      expect(Math.abs(got - c.out)).toBeLessThan(TOL);
    }
  });

  it("hitEndpoint", () => {
    const lines: EditorLine[] = F.hitEndpointLines.map((l) => ({
      key: l.key,
      label: l.label,
      e1: l.e1 as [number, number],
      e2: l.e2 as [number, number],
    }));
    for (const c of F.hitEndpoint) {
      const got = hitEndpoint(lines, c.point as [number, number], c.scale, c.radius);
      expect(got).toEqual(c.out);
    }
  });

  it("defaultPlacement", () => {
    for (const c of F.defaultPlacement) {
      const got = defaultLinePlacement(c.key, c.imgW, c.imgH);
      expect(got.e1).toEqual(c.e1);
      expect(got.e2).toEqual(c.e2);
    }
  });
});

// ── US-2686: moving an endpoint without a pointer ──────────────────────────
//
// The drag is reachable by exactly one input method. These pin the maths behind
// the keyboard alternative, and pin it against the iOS twin, because the two
// clients log correction deltas into the same table: if one press means a
// different distance on each, the deltas are not comparable.

describe("nudge (US-2686)", () => {
  const F = fixture as typeof fixture & {
    nudgeStep: Array<{ imgW: number; imgH: number; out: number }>;
    nudged: Array<{
      point: [number, number];
      direction: NudgeDirection;
      step: number;
      imgW: number;
      imgH: number;
      out: [number, number];
    }>;
  };

  it("step is proportional to the SHORT edge, floored at 1", () => {
    for (const c of F.nudgeStep) {
      expect(nudgeStep(c.imgW, c.imgH), `${c.imgW}x${c.imgH}`).toBe(c.out);
    }
  });

  it("a degenerate image still yields a step that MOVES something", () => {
    // A zero step is a control that reports success and moves nothing, which is
    // worse than no control at all. Not in the fixture as a formula case
    // because these are the inputs the formula does not define.
    for (const [w, h] of [[0, 0], [NaN, 100], [Infinity, Infinity], [-1, -1]]) {
      expect(nudgeStep(w!, h!)).toBeGreaterThanOrEqual(1);
    }
  });

  it("nudged moves one step and clamps at the image edge", () => {
    for (const c of F.nudged) {
      expect(
        nudged(c.point, c.direction, c.step, c.imgW, c.imgH),
        `${c.direction} from ${c.point.join(",")}`,
      ).toEqual(c.out);
    }
  });

  it("the coarse step is a whole multiple of the fine one", () => {
    // "Shift is five nudges" is a sentence someone can hold. Two independently
    // derived numbers is something they have to discover.
    expect(Number.isInteger(NUDGE_COARSE_MULTIPLE)).toBe(true);
    expect(NUDGE_COARSE_MULTIPLE).toBeGreaterThan(1);
  });

  it("iOS spells the SAME step formula (US-2534 twin)", () => {
    // A cross-platform assertion in a unit test, and it earns the place: the
    // fixture cannot reach Swift, and this number is the one thing the two
    // clients must agree on. Reading the source is weaker than running it and
    // is what is available on Windows — iOS CI compiles the file, this pins the
    // constant it compiles.
    const swift = readFileSync(
      resolve(import.meta.dirname, "../../../ios/GradeThread/Measure/MeasureNudge.swift"),
      "utf8",
    );
    const code = swift.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(
      code,
      "MeasureNudge.swift no longer derives the step from the short edge — the " +
        "two clients would disagree about what one press moves, and their " +
        "logged correction deltas would stop being comparable",
    ).toContain("min(imgW, imgH)");
    expect(code).toContain("0.005");
    expect(code, "the iOS floor of 1 is gone — a zero step moves nothing").toContain("max(1,");
  });
});
