// US-3331: check photos for blur and darkness BEFORE the seller pays.
//
// The vision pass judges blur, lighting and framing only after checkout, and a
// bad set ends as "Better photos needed" plus a refund. macro-photo-quality.ts
// already warns on soft or too-small close-ups and tags; this extends the same
// check to EVERY slot and adds the failure it never looked at: a photo too dark
// to show wear.
//
// Same posture as the macro gate, on purpose:
//   - it WARNS and offers a retake; it never blocks an upload;
//   - it runs in the browser on the compressed bytes; no network call;
//   - it FAILS OPEN: anything it could not measure passes.
//
// The full-shot blur floor is far below the macro one. A plain garment on a
// plain background has little texture however sharp it is, and a nudge that
// fires on sharp photos teaches sellers to ignore it (the same trade the macro
// header records). The floors are pinned against the synthetic fixture set in
// src/lib/photo-precheck.test.ts.

import {
  assessMacroPhoto,
  isMacroPhotoType,
  laplacianVariance,
  type MacroPhotoMeasurement,
  normalizeSharpness,
} from "@/lib/macro-photo-quality";

export interface PhotoMeasurement extends MacroPhotoMeasurement {
  /** Mean Rec. 601 luma of the downscaled copy, 0..255, or null. */
  meanLuma: number | null;
  /** Share of pixels darker than DARK_PIXEL_LUMA, 0..1, or null. */
  darkFraction: number | null;
}

export type PrecheckReason = "low_resolution" | "unsharp" | "dark";

export interface PrecheckResult {
  /** Seller-facing lines, in the order they should be read. Empty = fine. */
  warnings: string[];
  reasons: PrecheckReason[];
}

/** A pixel this dark (0..255) carries no visible wear detail. */
export const DARK_PIXEL_LUMA = 40;
/** Mean luma under this reads as a dark photo. */
export const DARK_MEAN_LUMA = 55;
/** Or: this share of the frame is near-black. */
export const DARK_FRACTION_MAX = 0.6;
/** Sharpness floor for a full-garment shot (the macro floors are ~0.22). */
export const FULL_SHOT_MIN_SHARPNESS = 0.05;

export const DARK_MESSAGE =
  "This photo is too dark to show wear clearly. Retake it near a window or under a bright light.";
export const FULL_SHOT_BLUR_MESSAGE =
  "This photo looks blurry. Hold steady, tap the garment to focus, and retake it.";

/** Mean luma and near-black share of a grayscale buffer. Pure. */
export function lightStats(gray: ArrayLike<number>): {
  meanLuma: number;
  darkFraction: number;
} {
  const n = gray.length;
  if (n === 0) return { meanLuma: 0, darkFraction: 0 };
  let sum = 0;
  let dark = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i] as number;
    sum += v;
    if (v < DARK_PIXEL_LUMA) dark++;
  }
  return { meanLuma: sum / n, darkFraction: dark / n };
}

/** True when the measured light says the photo is too dark. Unknown = fine. */
export function isTooDark(m: Pick<PhotoMeasurement, "meanLuma" | "darkFraction">): boolean {
  const meanDark = m.meanLuma != null && Number.isFinite(m.meanLuma) && m.meanLuma < DARK_MEAN_LUMA;
  const mostlyBlack = m.darkFraction != null && Number.isFinite(m.darkFraction) &&
    m.darkFraction > DARK_FRACTION_MAX;
  return meanDark || mostlyBlack;
}

/**
 * Assess one captured photo. Pure. Macro slots keep exactly the macro gate's
 * verdict and wording; every slot gets the darkness check; non-macro slots get
 * the lenient full-shot blur floor.
 */
export function assessPhotoPrecheck(m: PhotoMeasurement): PrecheckResult {
  const warnings: string[] = [];
  const reasons: PrecheckReason[] = [];

  if (isMacroPhotoType(m.photoType, m.photoRole)) {
    const macro = assessMacroPhoto(m);
    if (!macro.ok && macro.message && macro.reason) {
      warnings.push(macro.message);
      reasons.push(macro.reason);
    }
  } else if (
    m.sharpness != null &&
    Number.isFinite(m.sharpness) &&
    m.sharpness < FULL_SHOT_MIN_SHARPNESS
  ) {
    warnings.push(FULL_SHOT_BLUR_MESSAGE);
    reasons.push("unsharp");
  }

  if (isTooDark(m)) {
    warnings.push(DARK_MESSAGE);
    reasons.push("dark");
  }
  return { warnings, reasons };
}

const SAMPLE_LONG_EDGE = 256;

/**
 * Measure a captured image in the browser, for any slot: long edge at native
 * resolution, sharpness and light off one downscaled grayscale copy.
 *
 * Never throws; a decode or canvas failure returns nulls, which
 * assessPhotoPrecheck reads as "cannot tell" and passes.
 */
export async function measurePhoto(
  source: Blob,
  photoType: string | null | undefined,
  photoRole?: string | null,
): Promise<PhotoMeasurement> {
  const unmeasured: PhotoMeasurement = {
    photoType,
    photoRole,
    longEdge: null,
    sharpness: null,
    meanLuma: null,
    darkFraction: null,
  };
  try {
    const bitmap = await createImageBitmap(source);
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    if (!srcW || !srcH) return unmeasured;
    const longEdge = Math.max(srcW, srcH);
    const scale = Math.min(1, SAMPLE_LONG_EDGE / longEdge);
    const w = Math.max(3, Math.round(srcW * scale));
    const h = Math.max(3, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      return { ...unmeasured, longEdge };
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] =
        0.299 * (data[i] as number) +
        0.587 * (data[i + 1] as number) +
        0.114 * (data[i + 2] as number);
    }
    const light = lightStats(gray);
    return {
      photoType,
      photoRole,
      longEdge,
      sharpness: normalizeSharpness(laplacianVariance(gray, w, h)),
      meanLuma: light.meanLuma,
      darkFraction: light.darkFraction,
    };
  } catch {
    return unmeasured;
  }
}
