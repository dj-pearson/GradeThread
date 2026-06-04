import { describe, it, expect } from "vitest";
import {
  analyzeStats,
  applyAdjust,
  detectSubjectBBox,
  type EnhanceStats,
} from "./image-enhance";

// Build an w×h RGBA buffer from a per-pixel color function.
function buffer(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  return d;
}

describe("analyzeStats", () => {
  it("gray-world gains are ~1 for a neutral image", () => {
    const d = buffer(16, 16, () => [120, 120, 120]);
    const s = analyzeStats(d);
    expect(s.gainR).toBeCloseTo(1, 2);
    expect(s.gainG).toBeCloseTo(1, 2);
    expect(s.gainB).toBeCloseTo(1, 2);
  });

  it("corrects a color cast (warm image → boost blue, cut red)", () => {
    const d = buffer(16, 16, () => [180, 120, 60]);
    const s = analyzeStats(d);
    expect(s.gainR).toBeLessThan(1);
    expect(s.gainB).toBeGreaterThan(1);
  });

  it("clamps gains for an extreme cast", () => {
    const d = buffer(16, 16, () => [250, 10, 10]);
    const s = analyzeStats(d);
    expect(s.gainR).toBeGreaterThanOrEqual(0.7);
    expect(s.gainB).toBeLessThanOrEqual(1.4);
  });
});

describe("applyAdjust", () => {
  it("identity stats leave pixels unchanged", () => {
    const id: EnhanceStats = { gainR: 1, gainG: 1, gainB: 1, black: 0, white: 255 };
    const d = buffer(4, 4, (x) => [x * 10, x * 10, x * 10]);
    const copy = Uint8ClampedArray.from(d);
    applyAdjust(d, id);
    expect(Array.from(d)).toEqual(Array.from(copy));
  });

  it("auto-levels stretch lifts whites toward 255", () => {
    // Mid-range pixels with a levels window of [40,200] should expand.
    const s: EnhanceStats = { gainR: 1, gainG: 1, gainB: 1, black: 40, white: 200 };
    const d = buffer(1, 1, () => [200, 200, 200]);
    applyAdjust(d, s);
    expect(d[0]).toBe(255);
  });
});

describe("detectSubjectBBox", () => {
  it("returns the full frame when the image is uniform", () => {
    const w = 40;
    const h = 40;
    const d = buffer(w, h, () => [200, 200, 200]);
    const b = detectSubjectBBox(d, w, h);
    expect(b).toEqual({ x: 0, y: 0, w, h });
  });

  it("finds a contrasting subject block and crops near it", () => {
    const w = 100;
    const h = 100;
    // Dark background, bright block from (30,30) to (70,70).
    const d = buffer(w, h, (x, y) =>
      x >= 30 && x <= 70 && y >= 30 && y <= 70 ? [240, 240, 240] : [10, 10, 10],
    );
    const b = detectSubjectBBox(d, w, h);
    // Crop should bracket the block (with the ~3% margin), not the whole frame.
    expect(b.x).toBeGreaterThan(20);
    expect(b.x).toBeLessThanOrEqual(30);
    expect(b.w).toBeLessThan(w);
    expect(b.x + b.w).toBeGreaterThanOrEqual(70);
  });
});
