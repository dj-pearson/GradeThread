// US-535: on-device background removal + studio-white compositing.
// US-3069: the segmenter behind it swapped off an AGPL library.
//
// Runs a permissively-licensed segmentation model entirely in the browser — no
// per-image API cost — and composites the cutout per `mode`, ready to drop
// straight into the AutoLister staging pipeline.
//
// ── WHAT CHANGED, AND WHY IT HAD TO ─────────────────────────────────────────
//
// This used to call @imgly/background-removal. That package is AGPL-3.0 — its
// LICENSE.md is the AGPL v3 text, while npm reports only "SEE LICENSE IN
// LICENSE.md", which is why a licence sweep never surfaced it — and its
// JavaScript was served from gradethread.com in a lazy chunk from US-535
// onwards. Lazy-loading changes WHEN code is conveyed, not whether. The full
// evidence is in vault/30-platform/background-removal-licence.md.
//
// The replacement is U^2-Net (Apache 2.0) through onnxruntime-web (MIT), both
// checked rather than assumed, and both served same-origin so no vendor CDN is
// in the path either. lib/segment-u2net.ts carries that reasoning.
//
// ── AND IT FAILS TO THE SERVER, NOT TO NOTHING ─────────────────────────────
//
// The model weights are not vendored yet, so `available()` answers false and
// this throws NoLocalSegmenter. Every caller already has the server
// /api/flipdesk/images/remove-bg path (use-remove-bg.ts) and uses it — which is
// where the product was before US-535: it costs money per image rather than
// correctness. When /models/u2netp.onnx and the ort WASM are being served, the
// local path takes over with no further change here.

import {
  available as segmenterAvailable,
  foregroundMask,
  sampleMask,
  INPUT_SIZE,
} from "./segment-u2net";

export type BgMode = "white" | "transparent";

export interface ProcessedImage {
  /** Main image: JPEG for white-backdrop, PNG (alpha preserved) for transparent. */
  full: Blob;
  /** 320px thumbnail in the same format. */
  thumb: Blob;
  width: number;
  height: number;
  contentType: "image/jpeg" | "image/png";
  ext: "jpg" | "png";
}

/** Progress callback: 0..1 overall. */
export type BgProgress = (fraction: number) => void;

const MAX_EDGE = 2400;
const THUMB_EDGE = 320;

/**
 * Thrown when the on-device model is not being served.
 *
 * A NAMED error rather than a null return, because the caller's correct
 * response is specific: fall back to the server route. A null would be handled
 * as "no cutout" and silently ship the original photo, which looks like the
 * feature ran and did nothing.
 */
export class NoLocalSegmenter extends Error {
  constructor() {
    super("On-device background removal is not available in this build.");
    this.name = "NoLocalSegmenter";
  }
}

/** Is the on-device path usable right now? Callers use this to pick a route. */
export function localBackgroundRemovalAvailable(): Promise<boolean> {
  return segmenterAvailable();
}

/**
 * Remove the background from `input` and composite it per `mode`.
 *
 * @throws NoLocalSegmenter when the model is not vendored — fall back to the
 *         server route rather than treating it as a failed removal.
 */
export async function removeImageBackground(
  input: Blob,
  mode: BgMode,
  onProgress?: BgProgress,
): Promise<ProcessedImage> {
  const source = await createImageBitmap(input);
  try {
    const mask = await foregroundMask(source, onProgress);
    if (!mask) throw new NoLocalSegmenter();

    const isWhite = mode === "white";
    const contentType: "image/jpeg" | "image/png" = isWhite ? "image/jpeg" : "image/png";
    const ext: "jpg" | "png" = isWhite ? "jpg" : "png";

    const main = composite(source, mask, MAX_EDGE, isWhite);
    const full = await toBlob(main.canvas, contentType, 0.92);
    const t = composite(source, mask, THUMB_EDGE, isWhite);
    const thumb = await toBlob(t.canvas, contentType, 0.8);
    onProgress?.(1);

    return { full, thumb, width: main.w, height: main.h, contentType, ext };
  } finally {
    source.close();
  }
}

/**
 * Draw `bitmap` scaled to fit `maxEdge`, with `mask` as its alpha.
 *
 * ⚠ ON WHITE THE ALPHA IS COMPOSITED, NOT THRESHOLDED. A hard cut at 0.5 puts a
 * jagged edge on every garment; blending against white keeps the soft boundary
 * that makes a cutout look like a photo rather than a sticker.
 */
function composite(
  bitmap: ImageBitmap,
  mask: Float32Array,
  maxEdge: number,
  white: boolean,
): { canvas: HTMLCanvasElement; w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  for (let y = 0; y < h; y++) {
    const v = h > 1 ? y / (h - 1) : 0;
    for (let x = 0; x < w; x++) {
      const u = w > 1 ? x / (w - 1) : 0;
      const a = sampleMask(mask, INPUT_SIZE, u, v);
      const i = (y * w + x) * 4;
      if (white) {
        // Blend toward white in place, so the output needs no alpha channel.
        px[i] = Math.round(px[i]! * a + 255 * (1 - a));
        px[i + 1] = Math.round(px[i + 1]! * a + 255 * (1 - a));
        px[i + 2] = Math.round(px[i + 2]! * a + 255 * (1 - a));
        px[i + 3] = 255;
      } else {
        px[i + 3] = Math.round(a * 255);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, w, h };
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      type,
      quality,
    ),
  );
}
