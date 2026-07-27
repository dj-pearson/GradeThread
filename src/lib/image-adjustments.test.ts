import { describe, it, expect } from "vitest";
import {
  NEUTRAL_ADJUSTMENTS,
  analyzeTone,
  applyWarmth,
  autoAdjust,
  clampAdjustments,
  filterString,
  isNeutral,
  needsPixelPass,
  pickReferenceIndex,
  solveToneMatch,
  toneDistance,
  unsharpMask,
} from "./image-adjustments";

/** Build a solid-colour RGBA buffer. */
function solid(r: number, g: number, b: number, pixels = 400): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Grey ramp spanning [lo, hi] — a controllable luminance histogram. */
function ramp(lo: number, hi: number, pixels = 400): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const v = lo + ((hi - lo) * i) / (pixels - 1);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe("filterString", () => {
  it("emits nothing for neutral adjustments", () => {
    expect(filterString(NEUTRAL_ADJUSTMENTS)).toBe("none");
  });

  it("composes brightness before contrast before saturation", () => {
    // The solvers assume this order; a reordering silently breaks their math.
    const s = filterString({
      ...NEUTRAL_ADJUSTMENTS,
      brightness: 10,
      contrast: 20,
      saturation: -50,
    });
    expect(s).toBe("brightness(1.1) contrast(1.2) saturate(0.5)");
  });

  it("omits warmth and sharpness — those are pixel passes", () => {
    const s = filterString({
      ...NEUTRAL_ADJUSTMENTS,
      warmth: 40,
      sharpness: 60,
    });
    expect(s).toBe("none");
    expect(needsPixelPass({ ...NEUTRAL_ADJUSTMENTS, warmth: 40 })).toBe(true);
    expect(needsPixelPass({ ...NEUTRAL_ADJUSTMENTS, sharpness: 5 })).toBe(true);
    expect(needsPixelPass(NEUTRAL_ADJUSTMENTS)).toBe(false);
  });
});

describe("clampAdjustments", () => {
  it("holds every field inside its slider range", () => {
    const c = clampAdjustments({
      brightness: 500,
      contrast: -500,
      saturation: 0,
      warmth: -900,
      sharpness: -20,
    });
    expect(c).toEqual({
      brightness: 100,
      contrast: -100,
      saturation: 0,
      warmth: -100,
      sharpness: 0,
    });
  });

  it("recognises the neutral object", () => {
    expect(isNeutral(NEUTRAL_ADJUSTMENTS)).toBe(true);
    expect(isNeutral({ ...NEUTRAL_ADJUSTMENTS, warmth: 0.5 })).toBe(false);
  });
});

describe("analyzeTone", () => {
  it("reports per-channel means and luminance percentiles", () => {
    const stats = analyzeTone(ramp(100, 150), 1);
    expect(stats.meanLuma).toBeGreaterThan(120);
    expect(stats.meanLuma).toBeLessThan(130);
    expect(stats.p05).toBeGreaterThanOrEqual(100);
    expect(stats.p95).toBeLessThanOrEqual(150);
    expect(stats.sampled).toBe(400);
  });

  it("treats a near-grey image as a usable white-balance reference", () => {
    const stats = analyzeTone(solid(180, 170, 160), 1);
    expect(stats.neutralR).toBeCloseTo(180, 0);
    expect(stats.neutralB).toBeCloseTo(160, 0);
  });

  it("refuses a saturated garment as a white-balance reference", () => {
    // A genuinely red shirt is not a grey card. Grey-world would 'correct' it
    // into a washed-out mess; the neutral-pixel filter must reject it outright.
    const stats = analyzeTone(solid(200, 60, 60), 1);
    expect(stats.neutralR).toBeNull();
    expect(stats.neutralB).toBeNull();
  });

  it("ignores fully transparent pixels", () => {
    const data = solid(200, 200, 200, 10);
    for (let i = 0; i < 5; i++) data[i * 4 + 3] = 0; // half the image cut out
    const stats = analyzeTone(data, 1);
    expect(stats.sampled).toBe(5);
    expect(stats.meanLuma).toBeCloseTo(200, 0);
  });

  it("survives an empty buffer", () => {
    const stats = analyzeTone(new Uint8ClampedArray(0), 1);
    expect(stats.sampled).toBe(0);
    expect(autoAdjust(stats)).toEqual(NEUTRAL_ADJUSTMENTS);
  });
});

describe("autoAdjust", () => {
  it("stretches a flat, low-contrast photo", () => {
    const adj = autoAdjust(analyzeTone(ramp(100, 150), 1));
    expect(adj.contrast).toBeGreaterThan(20);
  });

  it("cools a warm-cast photo and warms a cool-cast one", () => {
    const warm = autoAdjust(analyzeTone(solid(200, 150, 100), 1));
    expect(warm.warmth).toBeLessThan(0);
    const cool = autoAdjust(analyzeTone(solid(100, 150, 200), 1));
    expect(cool.warmth).toBeGreaterThan(0);
  });

  it("leaves an already-neutral, full-range photo alone", () => {
    const adj = autoAdjust(analyzeTone(ramp(6, 249), 1));
    expect(Math.abs(adj.brightness)).toBeLessThan(3);
    expect(Math.abs(adj.contrast)).toBeLessThan(3);
    expect(adj.warmth).toBe(0);
  });

  it("never touches saturation — that would flatter the garment", () => {
    expect(autoAdjust(analyzeTone(solid(200, 150, 100), 1)).saturation).toBe(0);
  });

  it("does not amplify a flat image into noise", () => {
    // Zero spread carries no levels information; a naive solve would divide by
    // ~0 and return an enormous gain.
    const adj = autoAdjust(analyzeTone(solid(128, 128, 128), 1));
    expect(adj.brightness).toBe(0);
    expect(adj.contrast).toBe(0);
  });
});

describe("solveToneMatch", () => {
  it("is a no-op when a photo is matched against itself", () => {
    const stats = analyzeTone(ramp(60, 200), 1);
    const adj = solveToneMatch(stats, stats);
    expect(Math.abs(adj.brightness)).toBeLessThan(1);
    expect(Math.abs(adj.contrast)).toBeLessThan(1);
    expect(Math.abs(adj.warmth)).toBeLessThan(1);
  });

  it("cools a warm photo toward a neutral reference", () => {
    // The founder's actual case: one photo bright-white, another warm-toned.
    const warm = analyzeTone(solid(190, 170, 140), 1);
    const neutral = analyzeTone(solid(180, 178, 176), 1);
    expect(solveToneMatch(warm, neutral).warmth).toBeLessThan(-1);
  });

  it("brightens a dark photo toward a brighter reference", () => {
    const dark = analyzeTone(ramp(20, 90), 1);
    const bright = analyzeTone(ramp(120, 240), 1);
    expect(solveToneMatch(dark, bright).brightness).toBeGreaterThan(0);
  });

  it("returns neutral when either side has no pixels", () => {
    const empty = analyzeTone(new Uint8ClampedArray(0), 1);
    const real = analyzeTone(ramp(50, 200), 1);
    expect(solveToneMatch(empty, real)).toEqual(NEUTRAL_ADJUSTMENTS);
    expect(solveToneMatch(real, empty)).toEqual(NEUTRAL_ADJUSTMENTS);
  });
});

describe("pickReferenceIndex", () => {
  it("picks the most representative photo, not simply the first", () => {
    // Two consistent photos plus one wild outlier: the outlier must not win,
    // or bulk matching would drag the whole set toward the worst shot.
    const all = [
      analyzeTone(solid(60, 55, 50), 1), // outlier: dark
      analyzeTone(solid(180, 178, 176), 1),
      analyzeTone(solid(182, 180, 178), 1),
    ];
    expect(pickReferenceIndex(all)).not.toBe(0);
  });

  it("handles an empty set", () => {
    expect(pickReferenceIndex([])).toBe(0);
  });
});

describe("toneDistance", () => {
  it("is zero for identical tone and grows with divergence", () => {
    const a = analyzeTone(solid(180, 178, 176), 1);
    const b = analyzeTone(solid(180, 178, 176), 1);
    const c = analyzeTone(solid(120, 100, 80), 1);
    expect(toneDistance(a, b)).toBeCloseTo(0, 5);
    expect(toneDistance(a, c)).toBeGreaterThan(toneDistance(a, b));
  });
});

describe("applyWarmth", () => {
  it("raises red and lowers blue when warming", () => {
    const data = solid(100, 100, 100, 1);
    applyWarmth(data, 100);
    expect(data[0]).toBeGreaterThan(100);
    expect(data[2]).toBeLessThan(100);
    expect(data[1]).toBe(100); // green is the anchor
  });

  it("inverts for a cooling shift", () => {
    const data = solid(100, 100, 100, 1);
    applyWarmth(data, -100);
    expect(data[0]).toBeLessThan(100);
    expect(data[2]).toBeGreaterThan(100);
  });

  it("preserves alpha", () => {
    const data = solid(100, 100, 100, 1);
    data[3] = 128;
    applyWarmth(data, 80);
    expect(data[3]).toBe(128);
  });
});

describe("unsharpMask", () => {
  /** 6x6 with a vertical step edge at x=3, headroom at both ends so the
   *  Uint8ClampedArray can't clip away the over/undershoot we're measuring. */
  function stepEdge(): Uint8ClampedArray {
    const data = new Uint8ClampedArray(6 * 6 * 4);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        const o = (y * 6 + x) * 4;
        const v = x < 3 ? 100 : 155;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    return data;
  }

  it("increases contrast across an edge", () => {
    const data = stepEdge();
    const dark = (2 * 6 + 2) * 4; // last dark pixel of the middle row
    const light = (2 * 6 + 3) * 4; // first light pixel
    const darkBefore = data[dark]!;
    const lightBefore = data[light]!;
    unsharpMask(data, 6, 6, 1.0);
    expect(data[dark]!).toBeLessThan(darkBefore); // undershoot
    expect(data[light]!).toBeGreaterThan(lightBefore); // overshoot
  });

  it("is a no-op at zero amount", () => {
    const data = ramp(50, 200, 16); // read as 4x4
    const before = new Uint8ClampedArray(data);
    unsharpMask(data, 4, 4, 0);
    expect(Array.from(data)).toEqual(Array.from(before));
  });

  it("leaves alpha untouched so cut-outs do not fringe", () => {
    const data = stepEdge();
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 3; x++) data[(y * 6 + x) * 4 + 3] = 0;
    }
    unsharpMask(data, 6, 6, 1.0);
    expect(data[(2 * 6 + 0) * 4 + 3]).toBe(0);
    expect(data[(2 * 6 + 5) * 4 + 3]).toBe(255);
  });

  it("ignores images too small to blur", () => {
    const data = solid(100, 100, 100, 2);
    const before = new Uint8ClampedArray(data);
    unsharpMask(data, 2, 1, 1.0);
    expect(Array.from(data)).toEqual(Array.from(before));
  });
});
