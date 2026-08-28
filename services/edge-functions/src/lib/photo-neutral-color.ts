// Garment colour measured off the pixels, and the veto it feeds (US-2975).
//
// WHY THIS EXISTS. The AI reads colour from photos a camera has already lied
// about. Auto-exposure meters a frame full of black fabric toward mid-grey and
// meters a pale garment on a white sheet downward, so absolute brightness in the
// file says almost nothing about the garment. Charcoal trousers came back
// "Black"; warm taupe trousers came back "Purple".
//
// WHAT FIXES IT. Brightness RELATIVE to a white reference in the same frame
// survives auto-exposure, because the exposure scales the whole scene together.
// Almost every listing photo contains something near-white (the backdrop, a
// hanger, a label, the floor), so the brightest near-neutral cells give both a
// white point and the channel gains that cancel warm or cool room light.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not name the colour. Calibration
// against 57 hand-marked photos showed naming is not safe: sage measures chroma
// 4.9 and taupe 5.8, which is the same range as grey, so no chroma cut separates
// "grey" from "a desaturated colour". Two layers use the numbers instead —
// `describeMeasurement` states them to the model before it answers, and
// `vetoColorClaim` rejects only the claims the measurement makes impossible.
// Everything else is left exactly as the AI wrote it.
//
// Pure and synchronous: pixels in, numbers out. No network, no decode, no state.

/** Long-edge resolution of the analysis grid. 96 keeps a 4000px photo under a
 *  millisecond of work while still resolving a bold stripe. */
const GRID = 96;

/** A white reference needs this many near-neutral cells to be believable. */
const ANCHOR_MIN_CELLS = 20;
/** ...and must be genuinely bright. A dark garment on a dark backdrop has no
 *  white in frame at all, and guessing one turns black into mid-grey. */
const ANCHOR_MIN_LUMINANCE = 0.45;
/** Cells counted as near-neutral when hunting the white reference. */
const ANCHOR_MAX_SATURATION = 0.12;
/** A clipped channel carries no information about the light, so a cell with one
 *  never anchors and never skews the illuminant estimate. */
const CLIPPED_CHANNEL = 0.99;

/** Backdrop is flood-filled from the frame edge: bright and near-neutral. */
const BACKDROP_MIN_LIGHTNESS = 76;
const BACKDROP_MAX_CHROMA = 14;

/** Below this the subject is a speck and the reading would be noise. */
const SUBJECT_MIN_COVERAGE = 0.08;
/** One shade must cover this much of the subject. A patterned garment fails it,
 *  which is the point: averaging a stripe produces a colour that isn't there. */
const DOMINANT_MIN_SHARE = 0.55;
/** Lightness half-width of the dominant cluster. */
const CLUSTER_HALF_WIDTH = 8;

/**
 * Chroma floor for a vivid colour word. Every garment in the calibration sample
 * that a human called a vivid colour measured at or above this (pink 11.9, red
 * 14.6, purple 17.9); genuinely near-neutral colours like taupe and sage sit at
 * 3 to 8. A claim of "purple" below this floor cannot be true.
 */
export const VIVID_MIN_CHROMA = 10;

/** "Black" above this lightness is not black. Solid black garments in the
 *  calibration sample topped out at 41; the gap to 52 is deliberate slack. */
export const BLACK_MAX_LIGHTNESS = 52;
/** "White" below this lightness is not white. White garments started at 64. */
export const WHITE_MIN_LIGHTNESS = 55;

/** Colour words that require real saturation to be true. */
const VIVID_WORDS = new Set([
  "purple", "violet", "magenta", "fuchsia",
  "red", "orange", "yellow", "pink",
  "teal", "turquoise",
]);

export interface NeutralReading {
  /** CIE L* of the garment's dominant surface, with the frame's white reference
   *  normalised to 100. Comparable across photos; raw pixel values are not. */
  lightness: number;
  /** CIE C*. Below VIVID_MIN_CHROMA the surface cannot carry a vivid colour. */
  chroma: number;
  /** CIE hue angle in degrees. */
  hue: number;
  /** sRGB hex of that surface after white balance, for a human or the model. */
  hex: string;
  /** Share of the subject covered by the dominant shade. 1 is a plain garment. */
  dominantShare: number;
  /** Share of the frame the subject occupies, once the backdrop is removed. */
  subjectCoverage: number;
}

export interface VetoResult {
  vetoed: boolean;
  /** Present when vetoed — safe to log and to show a seller. */
  reason?: string;
}

// ── colour maths ────────────────────────────────────────────────────────────

/** sRGB byte to linear light. Every average below happens in linear space;
 *  averaging gamma-encoded bytes biases every result toward the highlights. */
function toLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toSrgbByte(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Linear sRGB to CIE L*a*b*, with Y already normalised so the frame's white
 *  reference is 1.0 — which is what makes L* mean "lightness against the sheet". */
function toLab(r: number, g: number, b: number): { L: number; a: number; bb: number } {
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = luminance(r, g, b);
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  const f = (t: number) => (t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116);
  const fx = f(X / 0.95047);
  const fy = f(Y);
  const fz = f(Z / 1.08883);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), bb: 200 * (fy - fz) };
}

function median(xs: number[]): number {
  const s = xs.slice().sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)] ?? 0;
}

// ── the measurement ─────────────────────────────────────────────────────────

/**
 * Measure the dominant surface of the garment in a decoded RGBA buffer.
 *
 * Returns null — never a guess — when the frame cannot support a reading: no
 * white reference, a subject too small to trust, or a surface with no single
 * dominant shade. A null here means "leave the AI's answer alone".
 *
 * KNOWN MISS: stripes finer than one grid cell (pinstripes, fine houndstooth)
 * average away before the dominant-share guard can see them, and read as a plain
 * mid-grey. A texture measure was tried and rejected — a chunky knit scores as
 * patterned as a striped shirt, so it fails the garments it must not fail.
 */
export function measureNeutral(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): NeutralReading | null {
  if (width <= 0 || height <= 0) return null;
  if (rgba.length < width * height * 4) return null;

  const gw = width >= height ? GRID : Math.max(1, Math.round((GRID * width) / height));
  const gh = height > width ? GRID : Math.max(1, Math.round((GRID * height) / width));
  const n = gw * gh;

  // Area-average the photo into the grid, in linear light.
  const R = new Float64Array(n);
  const G = new Float64Array(n);
  const B = new Float64Array(n);
  for (let ty = 0; ty < gh; ty++) {
    const y0 = Math.floor((ty * height) / gh);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / gh));
    for (let tx = 0; tx < gw; tx++) {
      const x0 = Math.floor((tx * width) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / gw));
      let r = 0, g = 0, b = 0, count = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const i = (y * width + x) * 4;
          r += toLinear(rgba[i] ?? 0);
          g += toLinear(rgba[i + 1] ?? 0);
          b += toLinear(rgba[i + 2] ?? 0);
          count++;
        }
      }
      if (count === 0) count = 1;
      const k = ty * gw + tx;
      R[k] = r / count;
      G[k] = g / count;
      B[k] = b / count;
    }
  }

  // White reference, in two passes.
  //
  // The saturation test below cannot run on raw channels: under tungsten light a
  // genuinely white backdrop is strongly red-biased in the file, so a raw test
  // throws it out and the measurement declines exactly when white balance is
  // most needed. So estimate the illuminant crudely first, judge neutrality in
  // THAT space, then take the real gains from the raw values of the cells kept.
  //
  // The crude estimate is white-patch (the brightest cells ARE the light), not
  // grey-world (the average cell is grey). Grey-world was tried and is wrong for
  // this job: a large saturated garment drags the frame average toward its own
  // hue, which then disqualifies the real white backdrop and the measurement
  // declines on exactly the photos it should handle best.
  const unclippedCells: number[] = [];
  for (let k = 0; k < n; k++) {
    if (Math.max(R[k], G[k], B[k]) < CLIPPED_CHANNEL) unclippedCells.push(k);
  }
  if (unclippedCells.length < ANCHOR_MIN_CELLS) return null;
  unclippedCells.sort((a, b) => luminance(R[a], G[a], B[a]) - luminance(R[b], G[b], B[b]));
  const brightest = unclippedCells.slice(Math.floor(unclippedCells.length * 0.9));
  const provWhiteR = median(brightest.map((k) => R[k]));
  const provWhiteG = median(brightest.map((k) => G[k]));
  const provWhiteB = median(brightest.map((k) => B[k]));
  if (provWhiteR <= 0 || provWhiteG <= 0 || provWhiteB <= 0) return null;
  const provR = 1 / provWhiteR;
  const provG = 1 / provWhiteG;
  const provB = 1 / provWhiteB;

  const pool: number[] = [];
  for (let k = 0; k < n; k++) {
    if (Math.max(R[k], G[k], B[k]) >= CLIPPED_CHANNEL) continue;
    const r = R[k] * provR, g = G[k] * provG, b = B[k] * provB;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    if (sat < ANCHOR_MAX_SATURATION) pool.push(k);
  }
  if (pool.length < ANCHOR_MIN_CELLS) return null;
  pool.sort((a, b) => luminance(R[a], G[a], B[a]) - luminance(R[b], G[b], B[b]));
  const top = pool.slice(Math.floor(pool.length * 0.9));
  const anchorR = median(top.map((k) => R[k]));
  const anchorG = median(top.map((k) => G[k]));
  const anchorB = median(top.map((k) => B[k]));
  if (luminance(anchorR, anchorG, anchorB) < ANCHOR_MIN_LUMINANCE) return null;
  if (anchorR <= 0 || anchorG <= 0 || anchorB <= 0) return null;

  // Von Kries gains: the reference becomes neutral AND Y = 1, so every lightness
  // below is stated against the white in this photo rather than in the abstract.
  const gainR = 1 / anchorR;
  const gainG = 1 / anchorG;
  const gainB = 1 / anchorB;
  const balanced = (k: number) => {
    const r = R[k] * gainR, g = G[k] * gainG, b = B[k] * gainB;
    return { r, g, b, ...toLab(r, g, b) };
  };

  // Backdrop: flood fill inward from the frame edge over reference-like cells.
  // Keyed off the border rather than a centre crop, because a centre box keeps
  // swallowing sheet from between trouser legs and reading it as garment.
  const isBackdrop = (k: number) => {
    const c = balanced(k);
    return c.L > BACKDROP_MIN_LIGHTNESS && Math.hypot(c.a, c.bb) < BACKDROP_MAX_CHROMA;
  };
  const backdrop = new Uint8Array(n);
  const queue: number[] = [];
  const seed = (k: number) => {
    if (!backdrop[k] && isBackdrop(k)) {
      backdrop[k] = 1;
      queue.push(k);
    }
  };
  for (let x = 0; x < gw; x++) {
    seed(x);
    seed((gh - 1) * gw + x);
  }
  for (let y = 0; y < gh; y++) {
    seed(y * gw);
    seed(y * gw + gw - 1);
  }
  while (queue.length) {
    const k = queue.pop() as number;
    const x = k % gw;
    const y = (k / gw) | 0;
    if (x > 0) seed(k - 1);
    if (x < gw - 1) seed(k + 1);
    if (y > 0) seed(k - gw);
    if (y < gh - 1) seed(k + gw);
  }

  const subject: ReturnType<typeof balanced>[] = [];
  for (let k = 0; k < n; k++) if (!backdrop[k]) subject.push(balanced(k));
  const subjectCoverage = subject.length / n;
  if (subjectCoverage < SUBJECT_MIN_COVERAGE) return null;

  // Dominant shade: the biggest lightness cluster within the subject.
  const bins = new Map<number, number>();
  for (const c of subject) {
    const bin = Math.round(c.L / 5);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  let peak = 0;
  let peakCount = -1;
  for (const [bin, count] of bins) {
    if (count > peakCount) {
      peakCount = count;
      peak = bin * 5;
    }
  }
  const cluster = subject.filter((c) => Math.abs(c.L - peak) <= CLUSTER_HALF_WIDTH);
  const dominantShare = cluster.length / subject.length;
  if (dominantShare < DOMINANT_MIN_SHARE) return null;

  const r = median(cluster.map((c) => c.r));
  const g = median(cluster.map((c) => c.g));
  const b = median(cluster.map((c) => c.b));
  const lab = toLab(r, g, b);
  const chroma = Math.hypot(lab.a, lab.bb);
  const hue = ((Math.atan2(lab.bb, lab.a) * 180) / Math.PI + 360) % 360;
  const hex = "#" + [r, g, b].map((v) => toSrgbByte(v).toString(16).padStart(2, "0")).join("");

  return {
    lightness: lab.L,
    chroma,
    hue,
    hex,
    dominantShare,
    subjectCoverage,
  };
}

// ── the prompt fact ─────────────────────────────────────────────────────────

/**
 * One line of measured fact for the extraction prompt, stated BEFORE the model
 * answers. A model told "lightness 44 of 100, near-neutral, sample #66686d" does
 * not go on to call the garment black. This is the layer that carries the close
 * calls the veto deliberately will not touch.
 */
export function describeMeasurement(r: NeutralReading): string {
  const light = Math.round(r.lightness);
  const chroma = Math.round(r.chroma);
  const tone = r.chroma < VIVID_MIN_CHROMA
    ? "near-neutral (little or no colour saturation)"
    : `saturated, hue angle ${Math.round(r.hue)} degrees`;
  return (
    `Measured from the photo pixels against the white reference in the same frame, ` +
    `so camera exposure is already cancelled: garment lightness ${light} of 100 ` +
    `(0 is black, 100 is the white reference), colour saturation ${chroma}, ${tone}, ` +
    `sample swatch ${r.hex}. Treat these numbers as ground truth about lightness ` +
    `and saturation; name the colour consistently with them.`
  );
}

// ── the veto ────────────────────────────────────────────────────────────────

/**
 * Reject a colour the measurement makes impossible. Everything else passes
 * through untouched, including every word that can legitimately be near-neutral
 * (taupe, beige, olive, khaki, sage, brown, navy, cream). That restraint is the
 * guarantee that this cannot damage the colours the AI already gets right.
 */
export function vetoColorClaim(
  claim: string | null | undefined,
  reading: NeutralReading | null,
): VetoResult {
  if (!claim || !reading) return { vetoed: false };
  const words = claim.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length === 0) return { vetoed: false };

  const light = Math.round(reading.lightness);
  const chroma = Math.round(reading.chroma);

  if (words.includes("black") && reading.lightness > BLACK_MAX_LIGHTNESS) {
    return {
      vetoed: true,
      reason:
        `measured lightness ${light} of 100 against the white reference in the ` +
        `photo, well above black (black measures under ${BLACK_MAX_LIGHTNESS})`,
    };
  }
  if (words.includes("white") && reading.lightness < WHITE_MIN_LIGHTNESS) {
    return {
      vetoed: true,
      reason:
        `measured lightness ${light} of 100 against the white reference in the ` +
        `photo, far too dark for white (white measures over ${WHITE_MIN_LIGHTNESS})`,
    };
  }
  const vivid = words.find((w) => VIVID_WORDS.has(w));
  if (vivid && reading.chroma < VIVID_MIN_CHROMA) {
    return {
      vetoed: true,
      reason:
        `measured colour saturation ${chroma}, below the floor of ` +
        `${VIVID_MIN_CHROMA} that "${vivid}" requires; the garment is near-neutral`,
    };
  }
  return { vetoed: false };
}
