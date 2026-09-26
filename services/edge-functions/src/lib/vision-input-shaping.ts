// US-3529: send the vision API less, where less costs no accuracy.
//
// Two levers, both changing what the model SEES, so both ship through the
// grading-engine lifecycle: flag-gated, default OFF, byte-identical when off,
// and stamped so accuracy tracking can split the era.
//
//   GRADING_VISION_LONG_EDGE=<px>   Downscale each grading photo so its long
//     side is at most <px> before the per-image, authenticity and label calls.
//     Photos arrive at up to 2400x3200 and Sonnet 5 bills about 4,800 image
//     tokens at its own cap; 1568px is about half that. Stamp: "+ds<px>".
//     The defect zoom and fabric zoom still crop from the stored original, so
//     fine detail is recovered where it matters.
//   GRADING_SKIP_MEASUREMENT_FANOUT=1   Leave measurement_* photos out of the
//     per-image CONDITION pass (they still serve measurement). Each one was a
//     full vision call. Stamp: "+nomeasure".
//
// Run shadow and the eval gate with each flag on before turning it on.

import { Image } from "imagescript";
import { decodeToRgba } from "./image-decode.ts";
import { sniffImageFormat } from "./upload-validation.ts";

export function visionLongEdge(): number | null {
  const raw = Number(Deno.env.get("GRADING_VISION_LONG_EDGE"));
  return Number.isFinite(raw) && raw >= 512 ? Math.trunc(raw) : null;
}

export function skipMeasurementFanout(): boolean {
  const v = (Deno.env.get("GRADING_SKIP_MEASUREMENT_FANOUT") ?? "").trim()
    .toLowerCase();
  return v === "1" || v === "true";
}

export function isMeasurementImage(imageType: string): boolean {
  return imageType.startsWith("measurement_");
}

/**
 * Downscale `bytes` so the long side is at most `longEdge`, as JPEG. Returns
 * the input unchanged (shrunk=false) when it is already small enough, when the
 * format cannot be decoded here, or when anything throws: a grade must never
 * fail because a size optimisation did.
 */
export async function shrinkForVision(
  bytes: Uint8Array,
  longEdge: number,
): Promise<{ bytes: Uint8Array; shrunk: boolean }> {
  try {
    const format = sniffImageFormat(bytes);
    if (!format || format === "heic") return { bytes, shrunk: false };
    const decoded = await decodeToRgba(bytes, format);
    if (!decoded) return { bytes, shrunk: false };
    const { width, height, rgba } = decoded;
    if (Math.max(width, height) <= longEdge) return { bytes, shrunk: false };
    const img = new Image(width, height);
    img.bitmap.set(rgba);
    if (width >= height) img.resize(longEdge, Image.RESIZE_AUTO);
    else img.resize(Image.RESIZE_AUTO, longEdge);
    return { bytes: await img.encodeJPEG(88), shrunk: true };
  } catch {
    return { bytes, shrunk: false };
  }
}
