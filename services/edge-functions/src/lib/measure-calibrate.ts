// US-1572 calibration plumbing, lifted out of routes/flipdesk-measure.ts so the
// automatic pass (lib/measure-autofill.ts, US-2595) can reuse it without a lib
// importing a route. The route still re-exports every name from here, which is
// what keeps flipdesk-measure_test.ts importing from the route valid.

import { Image } from "imagescript";
import {
  calibrateMeasurePhoto,
  matMul3,
  type CalibrateResult,
  type GrayImage,
} from "./measure-detect.ts";

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
 * Grayscale an ImageScript image, downscaling to `maxDim`. Returns the gray
 * buffer plus the scale factor (resized = original * scale).
 *
 * US-2672: this used to call `img.resize(...)`, and **ImageScript's resize
 * mutates the receiver** — it shrinks the Image in place and returns the same
 * object. So the first rung of the resolution ladder permanently destroyed the
 * caller's photo, and the ladder that US-2627 added to rescue exactly the
 * large-garment case never saw a single extra pixel: rung two re-scaled a
 * 2000px image UP to 3000, which invents no detail and (measurably) trips the
 * blur gate. Worse, `scale` on that second rung came out 1.0 against the
 * already-shrunk image, so `rescaleCalibration` left a homography in 2000px
 * space while its caller measured in the original's — a silent factor-of-two
 * error in the inches.
 *
 * Downsampling straight into the gray buffer fixes the mutation by not
 * resizing at all. It also box-averages, which is what you want ahead of a
 * fiducial detector: every source pixel contributes, so a 1in square that lands
 * on 40 output pixels keeps its edges instead of being point-sampled.
 */
export function toGray(img: Image, maxDim = MAX_DETECT_DIM): {
  gray: GrayImage;
  scale: number;
} {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const gray = new Uint8Array(w * h);
  const lum = (px: number) => {
    const r = (px >>> 24) & 0xff, g = (px >>> 16) & 0xff, b = (px >>> 8) & 0xff;
    return (r * 299 + g * 587 + b * 114) / 1000;
  };

  if (w === img.width && h === img.height) {
    for (let y = 1; y <= img.height; y++) {
      for (let x = 1; x <= img.width; x++) {
        gray[(y - 1) * w + (x - 1)] = lum(img.getPixelAt(x, y) >>> 0);
      }
    }
    return { gray: { width: w, height: h, gray }, scale };
  }

  const xr = img.width / w, yr = img.height / h;
  for (let oy = 0; oy < h; oy++) {
    const sy0 = Math.floor(oy * yr);
    const sy1 = Math.max(sy0 + 1, Math.min(img.height, Math.floor((oy + 1) * yr)));
    for (let ox = 0; ox < w; ox++) {
      const sx0 = Math.floor(ox * xr);
      const sx1 = Math.max(sx0 + 1, Math.min(img.width, Math.floor((ox + 1) * xr)));
      let acc = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          // getPixelAt is 1-indexed.
          acc += lum(img.getPixelAt(sx + 1, sy + 1) >>> 0);
          n++;
        }
      }
      gray[oy * w + ox] = acc / n;
    }
  }
  return { gray: { width: w, height: h, gray }, scale };
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

// ── US-2627: the card is small because the GARMENT is big ────────────────────
//
// Detection ran at one fixed working size (MAX_DETECT_DIM), and the
// minimum-marker gate measured the card THERE rather than in the photo the
// seller actually took. So the gate was really "how much of the frame does the
// card fill", and that is a property of the garment, not of the photograph.
//
// The arithmetic, for a pair of pants: laid flat they run ~42in, so the frame
// covers ~50in. A 4032px-tall phone photo is then ~80px per inch, and the
// card's 1in markers are ~80px — plenty. Downscale to 2000px and they land at
// ~40px, exactly on the limit. A slightly bigger garment, or a little more
// margin around it, and the same well-shot photo is rejected with "move the
// camera closer" — advice that cannot be followed, because moving closer crops
// the garment the card is there to measure.
//
// So escalate instead of refusing: retry at higher resolution until the markers
// have the pixels the gate wants. The cheap rung still handles the common case
// (a shirt, a shot with the card near the lens), and the cost is paid once per
// photo — the calibration is cached on the row afterwards.
export const DETECT_DIM_LADDER = [MAX_DETECT_DIM, 3000, 4200] as const;

/** Failures that MORE PIXELS can fix. A bent card cannot be. */
const RESOLUTION_SENSITIVE = new Set([
  "markers_too_small",
  "card_not_fully_visible",
  "card_not_found",
]);

/**
 * US-2672: blur is conditionally one of them. A card that IS sharp still reads
 * soft once it has been downsampled to a few dozen pixels a side, because the
 * downsample is itself a low-pass filter — so at the cheap rung a large-garment
 * photo can be called too blurry when the only thing that was blurry is the
 * copy the detector was handed. If markers were found, the card is in there and
 * a bigger pass is worth the money; if none were, the softness is the photo's
 * and more pixels render the same problem larger.
 */
const BLUR_IS_WORTH_A_RETRY = "photo_too_blurry";

export interface AdaptiveCalibration {
  result: CalibrateResult;
  /** The gray the winning (or final) attempt used — reuse it for edge snapping. */
  gray: GrayImage;
  /** resized = original * scale, for the attempt in `gray`. */
  scale: number;
  /** Longest edge each attempt ran at, for logging a hard case. */
  attempted: number[];
}

/**
 * Calibrate, climbing the resolution ladder while the failure is one more
 * pixels could fix.
 *
 * `evidenceOnly` (the default) stops after the cheap rung when NO marker was
 * seen at all. That is what keeps the card SCAN affordable: it opens up to a
 * dozen photos and all but one of them are a garment with no card in it, so
 * paying three detections each to confirm the obvious would triple the cost of
 * every generation. Pass false when something already says this photo is the
 * card — a seller's own tag, or a direct /calibrate call naming it — because
 * then "no markers found" is itself likely a resolution problem.
 */
/**
 * The working sizes to try for a photo whose longest edge is `native`, cheapest
 * first. Never upscales (there is no more detail to find) and never repeats a
 * size, so a small photo runs exactly once.
 */
export function detectRungs(native: number): number[] {
  return [...new Set(DETECT_DIM_LADDER.map((d) => Math.min(d, native)))];
}

/**
 * Whether another, larger pass could plausibly change this answer.
 *
 * Split out because it is the whole decision, and testing it through real
 * images means synthesising multi-megapixel textured photos to reach one
 * branch — which is how the first version of this test asserted a climb on a
 * blank white image that the detector had (correctly) called too blurry.
 */
export function shouldEscalate(
  result: CalibrateResult,
  evidenceOnly: boolean,
): boolean {
  if (result.ok) return false;
  // A bent card is a property of the photograph. More pixels only render the
  // same problem larger.
  const retryable = RESOLUTION_SENSITIVE.has(result.reason) ||
    (result.reason === BLUR_IS_WORTH_A_RETRY && result.quality.markersFound > 0);
  if (!retryable) return false;
  // No marker anywhere at the cheap size, and nothing claims this IS the card:
  // stop rather than spend two more passes proving a garment shot is a garment
  // shot. Twelve photos per item makes that the difference between a scan that
  // is free and one that is not.
  if (evidenceOnly && result.quality.markersFound === 0) return false;
  return true;
}

export function calibrateAdaptive(
  img: Image,
  cards: Parameters<typeof calibrateMeasurePhoto>[1],
  opts: { evidenceOnly?: boolean } = {},
): AdaptiveCalibration {
  const evidenceOnly = opts.evidenceOnly ?? true;
  const rungs = detectRungs(Math.max(img.width, img.height));

  let last: AdaptiveCalibration | null = null;
  const attempted: number[] = [];
  for (const dim of rungs) {
    const { gray, scale } = toGray(img, dim);
    const result = calibrateMeasurePhoto(gray, cards);
    attempted.push(dim);
    last = { result, gray, scale, attempted: [...attempted] };
    if (!shouldEscalate(result, evidenceOnly)) return last;
  }
  return last!;
}

/**
 * US-2888: fold a freshly detected calibration onto whatever was stored,
 * keeping the seller's line placements.
 *
 * A forced re-detect is "read the card again", not "throw away my work". The
 * /calibrate route used to write a calibration with no `lines` at all, so
 * pressing "Detect card" on a photo whose measurements had been dragged into
 * position silently deleted every one of them -- and nothing about a button
 * named after the card suggests it would.
 *
 * The endpoints stay valid because a re-detect recomputes the RULER, not the
 * frame: the pixels are the same pixels. The one case where they would be stale
 * is an edit that replaced the image, and that path clears the whole stored
 * calibration before this is ever reached.
 */
export function withPreservedLines(
  fresh: StoredCalibration,
  previous: StoredCalibration | null | undefined,
): StoredCalibration {
  const lines = previous?.lines;
  if (!lines || Object.keys(lines).length === 0) return fresh;
  return { ...fresh, lines };
}
