// US-1574: the editor's pure math — px↔inch via the calibration homography,
// display-scale mapping, endpoint hit-testing, and default placements. These
// functions are the spec the iOS/Android editor ports mirror.
import { describe, expect, it } from "vitest";
import {
  applyHomography,
  defaultLinePlacement,
  fitScale,
  formatQuarter,
  hitEndpoint,
  inchesBetween,
  roundQuarterInch,
  type EditorLine,
} from "@/lib/measure-editor-math";

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
