import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INPUT_SIZE,
  MEAN,
  MODEL_PATH,
  ORT_WASM_PATH,
  STD,
  normalizeMask,
  sampleMask,
  toTensorData,
} from "@/lib/segment-u2net";

// US-3069. The maths that decides whether a cutout looks like a photo or like a
// sticker, and the licence facts that decided which model does it.
//
// None of this needs a model file, a GPU or a network — which is the point.
// Every one of these is a silent failure in production: a wrong normalisation
// constant, a skipped rescale or a nearest-neighbour resample all produce a
// plausible-looking mask that cuts the garment in the wrong place, and a smoke
// test that only asks "did it return an image" passes every one of them.

describe("the preprocessing matches U^2-Net's own (US-3069)", () => {
  it("uses ImageNet normalisation, not a 0..1 scale", () => {
    // Pinned against the reference implementation. A plain /255 here is the
    // most natural-looking wrong answer and produces a mask that is subtly off
    // everywhere rather than obviously broken anywhere.
    expect([...MEAN]).toEqual([0.485, 0.456, 0.406]);
    expect([...STD]).toEqual([0.229, 0.224, 0.225]);
  });

  it("writes planar CHW, not interleaved RGBA", () => {
    // ⚠ THE FIXTURE NEEDS size >= 2 TO SAY ANYTHING. At size 1 the plane is one
    // entry wide, so `out[plane + i]` and `out[i + 1]` are the same slot and an
    // interleaved writer passes — which is exactly what the first version of
    // this test did.
    const size = 2; // 4 pixels, so each plane is 4 wide
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, // red
      0, 255, 0, 255, // green
      0, 0, 255, 255, // blue
      255, 255, 255, 255, // white
    ]);
    const out = toTensorData(rgba, size);
    expect(out.length).toBe(3 * 4);

    const hi = (c: 0 | 1 | 2) => (1 - MEAN[c]) / STD[c];
    const lo = (c: 0 | 1 | 2) => (0 - MEAN[c]) / STD[c];
    // R plane: the four pixels' RED values, contiguous.
    expect(out[0]).toBeCloseTo(hi(0), 6);
    expect(out[1]).toBeCloseTo(lo(0), 6);
    expect(out[2]).toBeCloseTo(lo(0), 6);
    expect(out[3]).toBeCloseTo(hi(0), 6);
    // G plane starts at index 4, not interleaved after the first red.
    expect(out[4]).toBeCloseTo(lo(1), 6);
    expect(out[5]).toBeCloseTo(hi(1), 6);
    // B plane starts at 8.
    expect(out[10]).toBeCloseTo(hi(2), 6);
  });

  it("produces one value per channel per pixel at the model's input size", () => {
    const rgba = new Uint8ClampedArray(INPUT_SIZE * INPUT_SIZE * 4);
    expect(toTensorData(rgba).length).toBe(3 * INPUT_SIZE * INPUT_SIZE);
  });
});

describe("the mask rescale is not optional (US-3069)", () => {
  it("stretches the raw side output to the full 0..1 range", () => {
    // ⚠ THE STEP THAT IS EASY TO SKIP. U^2-Net's own script rescales d0 by its
    // min and max; the raw values are not calibrated probabilities. Skipping it
    // leaves a washed-out mask and a grey halo on the cutout, which reads as a
    // bad model rather than a missing line.
    const out = normalizeMask([0.4, 0.5, 0.6]);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(1, 6);
  });

  it("a flat map keeps the whole image rather than erasing it", () => {
    // A caller handed a blank cutout has lost the photo; one handed the
    // original has only lost the feature. That asymmetry picks the fallback.
    const out = normalizeMask([0.3, 0.3, 0.3]);
    expect([...out]).toEqual([1, 1, 1]);
    expect([...normalizeMask([])]).toEqual([]);
  });
});

describe("the mask is resampled bilinearly (US-3069)", () => {
  const mask = new Float32Array([0, 1, 1, 0]); // 2x2 checker

  it("returns the corner values exactly", () => {
    expect(sampleMask(mask, 2, 0, 0)).toBeCloseTo(0, 6);
    expect(sampleMask(mask, 2, 1, 0)).toBeCloseTo(1, 6);
    expect(sampleMask(mask, 2, 0, 1)).toBeCloseTo(1, 6);
    expect(sampleMask(mask, 2, 1, 1)).toBeCloseTo(0, 6);
  });

  it("blends between them instead of snapping", () => {
    // Nearest-neighbour would return 0 or 1 here. The stair-stepped edge people
    // read as a bad cutout is this line, on a mask that is fine.
    expect(sampleMask(mask, 2, 0.5, 0.5)).toBeCloseTo(0.5, 6);
    const edge = sampleMask(mask, 2, 0.25, 0);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
  });

  it("clamps outside the unit square rather than reading out of bounds", () => {
    expect(Number.isFinite(sampleMask(mask, 2, -1, -1))).toBe(true);
    expect(Number.isFinite(sampleMask(mask, 2, 2, 2))).toBe(true);
  });
});

describe("the AGPL library is gone and nothing points at a vendor CDN (US-3069)", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("@imgly/background-removal is not a dependency and is imported nowhere", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).not.toContain("@imgly/background-removal");
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain(
      "@imgly/background-removal",
    );
    for (const f of [
      "src/lib/background-removal.ts",
      "src/lib/segment-u2net.ts",
      "src/pages/flipdesk/autolister.tsx",
      "src/components/flipdesk/photo-editor-dialog.tsx",
    ]) {
      expect(read(f), `${f} still imports the AGPL library`).not.toMatch(
        /from ["']@imgly\/background-removal["']|import\(["']@imgly/,
      );
    }
  });

  it("the runtime it replaced it with is a DIRECT dependency now", () => {
    // It was transitive through the removed package. Leaving it transitive
    // would mean the next `npm prune` takes the runtime out from under us.
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["onnxruntime-web"]).toBeTruthy();
  });

  it("the model and the WASM are same-origin", () => {
    // The point of the swap is not only the licence: the previous library also
    // fetched its model and runtime from staticimgly.com. Both of these are
    // absolute paths on our own origin.
    expect(MODEL_PATH.startsWith("/")).toBe(true);
    expect(ORT_WASM_PATH.startsWith("/")).toBe(true);
    for (const p of [MODEL_PATH, ORT_WASM_PATH]) {
      expect(p).not.toMatch(/^https?:/);
    }
    expect(read("src/lib/segment-u2net.ts")).not.toMatch(/staticimgly|cdn\./);
  });

  it("a missing model is a NAMED error, not a generic failure", () => {
    // A generic "background removal failed" on a missing model blames the
    // photo, and the seller retries with a better one forever.
    const lib = read("src/lib/background-removal.ts");
    expect(lib).toMatch(/class NoLocalSegmenter extends Error/);
    // ⚠ THE DISTINCTION IS ASSERTED ON THE BEHAVIOUR, NOT ON WHERE IT LIVES.
    // The first version of this checked that each call site contained the
    // string "NoLocalSegmenter", and then went red when the branch was
    // correctly extracted into backgroundRemovalMessage() — a guard failing a
    // refactor that improved the thing it guards. What matters is that the
    // helper knows the error name and both screens go through it.
    expect(lib).toMatch(/backgroundRemovalMessage/);
    const helper = lib.slice(lib.indexOf("export function backgroundRemovalMessage"));
    expect(helper.slice(0, 400)).toMatch(/NoLocalSegmenter/);
    for (const f of [
      "src/pages/flipdesk/autolister.tsx",
      "src/components/flipdesk/photo-editor-dialog.tsx",
    ]) {
      expect(read(f), `${f} does not use the shared message`).toMatch(
        /backgroundRemovalMessage/,
      );
    }
  });

  it("neither screen writes its own copy of the message", () => {
    // A copy of a message is a message that drifts. This is what the extraction
    // bought, so it is what is pinned.
    for (const f of [
      "src/pages/flipdesk/autolister.tsx",
      "src/components/flipdesk/photo-editor-dialog.tsx",
    ]) {
      expect(read(f), `${f} hardcodes the missing-model copy`).not.toMatch(
        /isn't available in this build/,
      );
    }
  });
});
