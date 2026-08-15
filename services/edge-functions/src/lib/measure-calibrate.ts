// US-1572 calibration plumbing, lifted out of routes/flipdesk-measure.ts so the
// automatic pass (lib/measure-autofill.ts, US-2595) can reuse it without a lib
// importing a route. The route still re-exports every name from here, which is
// what keeps flipdesk-measure_test.ts importing from the route valid.

import { Image } from "imagescript";
import { matMul3, type CalibrateResult, type GrayImage } from "./measure-detect.ts";

/** Stored shape of item_photos.measure_calibration (versioned). */
export interface StoredCalibration {
  v: 1;
  cardVersion: number;
  ppi: number;
  homography: number[];
  quality: {
    markersFound: number;
    minMarkerSidePx: number;
    blurScore: number;
    reprojResidualIn: number;
  };
  computedAt: string;
  /** US-1577 (additive): per-measurement line geometry in original px —
   *  written by /extract, edited by the overlay editor, read by /overlay. */
  lines?: Record<
    string,
    { e1: [number, number]; e2: [number, number]; inches: number; label: string }
  >;
}

// Photos larger than this are downscaled before detection (speed) and the
// homography/ppi are mapped back to ORIGINAL pixel coordinates — stored
// calibrations are always in the stored image's own px space.
export const MAX_DETECT_DIM = 2000;

/**
 * Grayscale an ImageScript image, downscaling to MAX_DETECT_DIM. Returns the
 * gray buffer plus the scale factor (resized = original * scale).
 */
export function toGray(img: Image, maxDim = MAX_DETECT_DIM): {
  gray: GrayImage;
  scale: number;
} {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const work = scale < 1
    ? img.resize(
      Math.max(1, Math.round(img.width * scale)),
      Math.max(1, Math.round(img.height * scale)),
    )
    : img;
  const gray = new Uint8Array(work.width * work.height);
  for (let y = 1; y <= work.height; y++) {
    for (let x = 1; x <= work.width; x++) {
      const px = work.getPixelAt(x, y) >>> 0;
      const r = (px >>> 24) & 0xff,
        g = (px >>> 16) & 0xff,
        b = (px >>> 8) & 0xff;
      gray[(y - 1) * work.width + (x - 1)] = (r * 299 + g * 587 + b * 114) /
        1000;
    }
  }
  return {
    gray: { width: work.width, height: work.height, gray },
    scale,
  };
}

/**
 * Map a calibration computed on a DOWNSCALED image back into original pixel
 * coordinates: H_orig = H_small · diag(scale, scale, 1); ppi scales inversely.
 */
export function rescaleCalibration(
  res: Extract<CalibrateResult, { ok: true }>,
  scale: number,
): Extract<CalibrateResult, { ok: true }> {
  if (scale === 1) return res;
  const S = [scale, 0, 0, 0, scale, 0, 0, 0, 1];
  return {
    ...res,
    homography: matMul3(res.homography, S),
    ppi: res.ppi / scale,
    markers: res.markers.map((m) => ({
      ...m,
      sidePx: m.sidePx / scale,
      center: [m.center[0] / scale, m.center[1] / scale],
      corners: m.corners.map(([x, y]) =>
        [x / scale, y / scale] as [number, number]
      ),
    })),
  };
}
