import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { laplacianVariance, normalizeSharpness } from "@/lib/macro-photo-quality";
import {
  assessPhotoPrecheck,
  DARK_MESSAGE,
  FULL_SHOT_BLUR_MESSAGE,
  lightStats,
  type PhotoMeasurement,
} from "@/lib/photo-precheck";

// US-3331: the pre-payment photo check. The thresholds are pinned against a
// synthetic fixture set built here, deterministically, at the size the browser
// half samples (256px): a textured garment, the same texture blurred, a plain
// garment that is sharp but has little texture, and the textured one lit well
// and lit badly. Real-photo fixtures would need a decoder in the test runner;
// these exercise the exact math the browser runs on its grayscale buffer.

const W = 256;
const H = 256;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

/** Knit-like texture: noise between lo and hi. */
function texture(lo: number, hi: number, seed = 7): Float32Array {
  const r = lcg(seed);
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = lo + r() * (hi - lo);
  return g;
}

/** A plain garment: flat light-grey rectangle on a darker backdrop. */
function plainGarment(): Float32Array {
  const g = new Float32Array(W * H).fill(90);
  for (let y = 48; y < 208; y++) for (let x = 64; x < 192; x++) g[y * W + x] = 190;
  return g;
}

function boxBlur(src: Float32Array, radius: number, passes: number): Float32Array {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
            sum += a[yy * W + xx] as number;
            n++;
          }
        }
        out[y * W + x] = sum / n;
      }
    }
    a = out;
  }
  return a;
}

function measure(gray: Float32Array, photoType = "front"): PhotoMeasurement {
  const light = lightStats(gray);
  return {
    photoType,
    photoRole: null,
    longEdge: 2000,
    sharpness: normalizeSharpness(laplacianVariance(gray, W, H)),
    meanLuma: light.meanLuma,
    darkFraction: light.darkFraction,
  };
}

const SHARP = texture(60, 200);
const BLURRED = boxBlur(SHARP, 3, 3);
const PLAIN = plainGarment();
const DARK = texture(5, 50);

describe("fixture set: the thresholds sit between the cases they separate", () => {
  it("a sharp, well-lit garment draws no warning", () => {
    expect(assessPhotoPrecheck(measure(SHARP)).warnings).toEqual([]);
  });

  it("the same garment, blurred, is called blurry", () => {
    const r = assessPhotoPrecheck(measure(BLURRED));
    expect(r.reasons).toEqual(["unsharp"]);
    expect(r.warnings).toEqual([FULL_SHOT_BLUR_MESSAGE]);
  });

  it("a plain garment that is sharp is NOT called blurry", () => {
    // Little texture is not blur. A nudge that fires on sharp photos teaches
    // sellers to ignore it, which is why the full-shot floor is so low.
    expect(assessPhotoPrecheck(measure(PLAIN)).reasons).not.toContain("unsharp");
  });

  it("a dark photo is called dark", () => {
    const r = assessPhotoPrecheck(measure(DARK));
    expect(r.reasons).toContain("dark");
    expect(r.warnings).toContain(DARK_MESSAGE);
  });

  it("a photo that is both blurry and dark says both, blur first", () => {
    const r = assessPhotoPrecheck(measure(boxBlur(DARK, 3, 3)));
    expect(r.reasons).toEqual(["unsharp", "dark"]);
  });
});

describe("fails open", () => {
  it("nothing measured, nothing said", () => {
    expect(
      assessPhotoPrecheck({
        photoType: "front",
        photoRole: null,
        longEdge: null,
        sharpness: null,
        meanLuma: null,
        darkFraction: null,
      }).warnings,
    ).toEqual([]);
  });
});

describe("macro slots keep the macro gate's wording", () => {
  it("a blurred close-up gets the macro message, not the full-shot one", () => {
    const r = assessPhotoPrecheck(measure(BLURRED, "detail"));
    expect(r.reasons).toEqual(["unsharp"]);
    expect(r.warnings[0]).not.toBe(FULL_SHOT_BLUR_MESSAGE);
    expect(r.warnings[0]).toMatch(/blurry/i);
  });
});

describe("the upload slot warns and never blocks", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src/components/submission/photo-upload.tsx"),
    "utf8",
  );
  it("precheck results land in warnings, and the success path clears errors", () => {
    expect(src).toContain("const precheck = assessPhotoPrecheck(measured);");
    expect(src).toContain("warnings: precheck.warnings,");
    expect(src).not.toMatch(/errors:\s*precheck/);
  });
  it("no network call: the check is the local measurement only", () => {
    const lib = readFileSync(resolve(process.cwd(), "src/lib/photo-precheck.ts"), "utf8");
    expect(lib).not.toMatch(/\bfetch\(|edgeFetch|supabase/);
  });
});
