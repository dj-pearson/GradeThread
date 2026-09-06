// On-device foreground segmentation with U^2-Net, through onnxruntime-web.
//
// ── WHY THIS EXISTS: THE LIBRARY IT REPLACES IS AGPL-3.0 ────────────────────
//
// @imgly/background-removal is AGPL-3.0 (its LICENSE.md is the AGPL v3 text,
// while npm reports only "SEE LICENSE IN LICENSE.md", which is why a licence
// sweep never surfaced it). Its JavaScript was served from gradethread.com in a
// lazy chunk from US-535 until US-3069. Lazy-loading changes WHEN code is
// conveyed, not whether. See vault/30-platform/background-removal-licence.md.
//
// ── THE REPLACEMENT'S LICENCES, CHECKED RATHER THAN ASSUMED ─────────────────
//
//   onnxruntime-web  MIT (Microsoft). Already installed at 1.21.0 — it was a
//                    transitive dependency of the library being removed, so
//                    this is a promotion to a direct dependency, not a new one.
//   U^2-Net          Apache 2.0. Verified 2026-09-05 against the LICENSE file
//                    in github.com/xuebinqin/U-2-Net: no clause restricting
//                    commercial use.
//
// ⚠ AND THE OBVIOUS ALTERNATIVE IS WORSE, WHICH IS WHY IT IS NAMED HERE.
// BRIA's RMBG-1.4 is the model most background-removal examples reach for and
// it is explicitly NON-COMMERCIAL. Swapping one licence problem for a second is
// the failure this whole change exists to undo, so the model was chosen on its
// licence first and its quality second.
//
// ── IT IS INERT UNTIL THE WEIGHTS ARE VENDORED ─────────────────────────────
//
// `available()` answers false when /models/u2netp.onnx is not being served, and
// every caller falls back to the server /remove-bg route — which is exactly
// where the product was before US-535, and costs money per image rather than
// correctness. Nothing here throws at import time and nothing degrades silently:
// a missing model is a fallback, not a broken button.

import type { InferenceSessionLike } from "onnxruntime-web";

/** Where the vendored artifacts live, both same-origin. No third-party CDN. */
export const MODEL_PATH = "/models/u2netp.onnx";
export const ORT_WASM_PATH = "/models/ort/";

/** U^2-Net's fixed input side. The network is trained at 320x320. */
export const INPUT_SIZE = 320;

/**
 * ImageNet normalisation, which is what U^2-Net's own preprocessing applies.
 *
 * Getting these wrong does not error — it produces a mask that looks like a
 * plausible blob and cuts the garment in the wrong place, which is the failure
 * mode a smoke test passes straight through. They are exported so a test can
 * pin them against the reference implementation.
 */
export const MEAN = [0.485, 0.456, 0.406] as const;
export const STD = [0.229, 0.224, 0.225] as const;

let sessionPromise: Promise<InferenceSessionLike> | null = null;
let availability: boolean | null = null;

/** Is the model actually being served? Cached, and never throws. */
export async function available(): Promise<boolean> {
  if (availability !== null) return availability;
  try {
    const res = await fetch(MODEL_PATH, { method: "HEAD", cache: "force-cache" });
    availability = res.ok;
  } catch {
    availability = false;
  }
  return availability;
}

/** Reset the cached probe. Tests only. */
export function resetAvailability(): void {
  availability = null;
  sessionPromise = null;
}

/**
 * Scale a source bitmap into a 320x320 Float32 NCHW tensor.
 *
 * Exported and pure-ish so the normalisation can be tested against known
 * values without a model, a GPU or a network.
 */
export function toTensorData(
  rgba: Uint8ClampedArray,
  size = INPUT_SIZE,
): Float32Array {
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    // U^2-Net's reference preprocessing divides by 255 THEN normalises, and
    // writes planar CHW rather than interleaved RGBA.
    // The `!`s are the loop bounds made explicit: i < plane and the buffer is
    // 4 bytes per pixel, so every read is in range by construction.
    out[i] = (rgba[i * 4]! / 255 - MEAN[0]) / STD[0];
    out[plane + i] = (rgba[i * 4 + 1]! / 255 - MEAN[1]) / STD[1];
    out[plane * 2 + i] = (rgba[i * 4 + 2]! / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

/**
 * Min-max normalise the raw side output into a 0..1 alpha map.
 *
 * ⚠ THIS STEP IS NOT OPTIONAL AND IS EASY TO SKIP. U^2-Net's own inference
 * script rescales d0 by its own min and max before using it; the raw values are
 * not calibrated probabilities. Without it a correct model produces a washed-out
 * mask and the cutout keeps a grey halo, which reads as "the model is bad"
 * rather than "a normalisation is missing".
 */
export function normalizeMask(raw: Float32Array | number[]): Float32Array {
  const out = new Float32Array(raw.length);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (!(span > 0)) {
    // A flat map carries no information. Returning all-1 keeps the whole image
    // rather than erasing it: a caller that gets a blank cutout has lost the
    // photo, and one that gets the original has only lost the feature.
    out.fill(1);
    return out;
  }
  for (let i = 0; i < raw.length; i++) out[i] = (raw[i]! - min) / span;
  return out;
}

/**
 * The alpha value for a destination pixel, sampling the 320x320 mask bilinearly.
 *
 * Nearest-neighbour here is what produces the stair-stepped edge people read as
 * a bad cutout, on a mask that is actually fine.
 */
export function sampleMask(
  mask: Float32Array,
  size: number,
  u: number,
  v: number,
): number {
  const x = Math.min(size - 1, Math.max(0, u * (size - 1)));
  const y = Math.min(size - 1, Math.max(0, v * (size - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = mask[y0 * size + x0]!;
  const b = mask[y0 * size + x1]!;
  const c = mask[y1 * size + x0]!;
  const d = mask[y1 * size + x1]!;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Lazily create the inference session. Never called when available() is false. */
async function session(): Promise<InferenceSessionLike> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import("onnxruntime-web");
      // Same-origin WASM. The whole point of this change is that nothing is
      // fetched from a vendor CDN, so a default that points at one is wrong.
      ort.env.wasm.wasmPaths = ORT_WASM_PATH;
      return ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    })();
  }
  return (await sessionPromise) as InferenceSessionLike;
}

/**
 * Foreground alpha for `bitmap`, as a 320x320 map in 0..1, or null when the
 * model is not vendored.
 */
export async function foregroundMask(
  bitmap: ImageBitmap,
  onProgress?: (fraction: number) => void,
): Promise<Float32Array | null> {
  if (!(await available())) return null;
  onProgress?.(0.1);

  const c = document.createElement("canvas");
  c.width = INPUT_SIZE;
  c.height = INPUT_SIZE;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

  onProgress?.(0.3);
  const s = await session();
  const ort = await import("onnxruntime-web");
  const tensor = new ort.Tensor("float32", toTensorData(data), [1, 3, INPUT_SIZE, INPUT_SIZE]);

  onProgress?.(0.5);
  const output = await s.run({ [s.inputNames[0]!]: tensor });
  // U^2-Net emits seven side outputs; d0 is the fused one and is first.
  const first = Object.values(output)[0];
  if (!first) return null;
  onProgress?.(0.9);
  return normalizeMask(first.data);
}
