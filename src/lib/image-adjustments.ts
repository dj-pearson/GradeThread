// Photo enhancement math for the listing photo editor.
//
// Everything a seller can do to a photo's TONE is expressed as one `Adjustments`
// object, and there is exactly one renderer that applies it. The three entry
// points all just produce an `Adjustments`:
//
//   • the sliders            — the seller sets it by hand
//   • autoAdjust(stats)      — one-click levels stretch + grey-world white balance
//   • solveToneMatch(a, b)   — bulk "make these photos match each other"
//
// Keeping them in one currency means Auto and Tone-match land IN the sliders,
// so a seller can always see and nudge what was applied instead of receiving an
// opaque "enhanced" image.
//
// This module is deliberately free of canvas/DOM calls except in the clearly
// marked rendering section at the bottom — the math above it runs on a plain
// Uint8ClampedArray so it is unit-testable in node.

export interface Adjustments {
  /** -100..100 → multiplicative gain 0..2 */
  brightness: number;
  /** -100..100 → multiplicative gain 0..2 about mid-grey */
  contrast: number;
  /** -100..100 → saturation gain 0..2 */
  saturation: number;
  /** -100..100 → warm (+, red up / blue down) .. cool (−). ±25% channel gain. */
  warmth: number;
  /** 0..100 → unsharp-mask amount 0..1.5 */
  sharpness: number;
}

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  sharpness: 0,
};

/** Mid-point of the 0..255 range, the pivot CSS `contrast()` rotates about. */
const MID = 127.5;
/** Warmth slider → per-channel gain. ±100 ⇒ ±25%, a strong but not lurid shift. */
const WARMTH_SCALE = 400;

export function isNeutral(a: Adjustments): boolean {
  return (
    a.brightness === 0 &&
    a.contrast === 0 &&
    a.saturation === 0 &&
    a.warmth === 0 &&
    a.sharpness === 0
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Round to 1dp and clamp every field into its legal slider range. */
export function clampAdjustments(a: Adjustments): Adjustments {
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    brightness: r(clamp(a.brightness, -100, 100)),
    contrast: r(clamp(a.contrast, -100, 100)),
    saturation: r(clamp(a.saturation, -100, 100)),
    warmth: r(clamp(a.warmth, -100, 100)),
    sharpness: r(clamp(a.sharpness, 0, 100)),
  };
}

/**
 * The brightness/contrast/saturation part of `a` as a CSS filter string for
 * `ctx.filter`. These three are GPU-accelerated by the browser, so they stay
 * smooth under a slider drag; warmth and sharpness need a pixel pass instead.
 *
 * Order matters — filters compose left to right, and `autoAdjust`/`solveToneMatch`
 * both solve their gains assuming brightness is applied BEFORE contrast.
 */
export function filterString(a: Adjustments): string {
  const parts: string[] = [];
  if (a.brightness !== 0) parts.push(`brightness(${1 + a.brightness / 100})`);
  if (a.contrast !== 0) parts.push(`contrast(${1 + a.contrast / 100})`);
  if (a.saturation !== 0) parts.push(`saturate(${1 + a.saturation / 100})`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

/** True when `a` needs the (slower) per-pixel pass on top of `filterString`. */
export function needsPixelPass(a: Adjustments): boolean {
  return a.warmth !== 0 || a.sharpness > 0;
}

// ── Analysis ────────────────────────────────────────────────────────

export interface ToneStats {
  /** Mean of every pixel, per channel, 0..255. */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Rec.709 luminance mean, 0..255. */
  meanLuma: number;
  /** 5th / 95th luminance percentile — the usable range, ignoring outliers. */
  p05: number;
  p95: number;
  /** Mean of NEAR-NEUTRAL pixels only (see below), or null when too few exist. */
  neutralR: number | null;
  neutralB: number | null;
  /** How many pixels were sampled (post-stride). */
  sampled: number;
}

/** Rec.709 luminance. */
function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A pixel counts as "near neutral" when its channel spread is small relative to
// its brightness — i.e. it is some shade of grey/white, not a saturated colour.
// Estimating white balance from ONLY these avoids the classic grey-world failure
// where a genuinely red shirt reads as a red cast and gets "corrected" to grey.
const NEUTRAL_SPREAD_RATIO = 0.18;
// Ignore near-black pixels: channel noise dominates there and skews the ratio.
const NEUTRAL_MIN_LUMA = 40;
// Below this share of sampled pixels the neutral estimate isn't trustworthy and
// callers fall back to the global means.
const MIN_NEUTRAL_FRACTION = 0.02;

/**
 * Summarise an image's tone. `stride` samples every Nth pixel — at the default
 * of 4 a 12MP photo is characterised from ~750k pixels, which is statistically
 * identical and several times faster.
 */
export function analyzeTone(
  data: Uint8ClampedArray,
  stride = 4,
): ToneStats {
  const hist = new Uint32Array(256);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumL = 0;
  let n = 0;
  let neutralSumR = 0;
  let neutralSumB = 0;
  let neutralN = 0;

  // The `!` on each read is deliberate: the loop bound guarantees i+3 is in
  // range, and `noUncheckedIndexedAccess` would otherwise widen every typed-array
  // read to `number | undefined` inside the hottest loop in the module.
  const step = Math.max(1, Math.floor(stride)) * 4;
  for (let i = 0; i + 3 < data.length; i += step) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    // Fully transparent pixels (a cut-out's backdrop) carry no tone information.
    if (data[i + 3]! === 0) continue;
    const l = luma(r, g, b);
    sumR += r;
    sumG += g;
    sumB += b;
    sumL += l;
    const bin = Math.min(255, Math.round(l));
    hist[bin] = (hist[bin] ?? 0) + 1;
    n++;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (l >= NEUTRAL_MIN_LUMA && max - min <= max * NEUTRAL_SPREAD_RATIO) {
      neutralSumR += r;
      neutralSumB += b;
      neutralN++;
    }
  }

  if (n === 0) {
    return {
      meanR: 0, meanG: 0, meanB: 0, meanLuma: 0,
      p05: 0, p95: 255,
      neutralR: null, neutralB: null, sampled: 0,
    };
  }

  const enoughNeutral = neutralN >= n * MIN_NEUTRAL_FRACTION;
  return {
    meanR: sumR / n,
    meanG: sumG / n,
    meanB: sumB / n,
    meanLuma: sumL / n,
    p05: percentile(hist, n, 0.05),
    p95: percentile(hist, n, 0.95),
    neutralR: enoughNeutral ? neutralSumR / neutralN : null,
    neutralB: enoughNeutral ? neutralSumB / neutralN : null,
    sampled: n,
  };
}

/** Walk a 256-bin cumulative histogram to the bin holding the `q` quantile. */
function percentile(hist: Uint32Array, total: number, q: number): number {
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i] ?? 0;
    if (acc >= target) return i;
  }
  return 255;
}

/** White-balance reference channels: the neutral subset when we have one. */
function wbChannels(s: ToneStats): { r: number; b: number } {
  return s.neutralR != null && s.neutralB != null
    ? { r: s.neutralR, b: s.neutralB }
    : { r: s.meanR, b: s.meanB };
}

/**
 * Solve the warmth slider that would drive `from`'s red/blue balance to `to`'s.
 *
 * Warmth applies gains (1 + v/400) to red and (1 − v/400) to blue, so matching
 * the ratio t = to.r/to.b means solving  a(1+v/400) = t·b(1−v/400)  for v.
 */
function solveWarmth(
  from: { r: number; b: number },
  to: { r: number; b: number },
): number {
  const a = from.r;
  const b = from.b;
  if (a <= 0 || b <= 0 || to.b <= 0) return 0;
  const t = to.r / to.b;
  const denom = a + t * b;
  if (denom <= 0) return 0;
  return (WARMTH_SCALE * (t * b - a)) / denom;
}

/**
 * Solve brightness+contrast gains that map `[p05, p95]` onto `[lo, hi]`.
 *
 * With brightness applied first, the transform is f(x) = (x·bK − MID)·cK + MID.
 * Requiring f(p05)=lo and f(p95)=hi gives a two-equation system whose solution
 * is a true levels stretch rather than a guess.
 */
function solveLevels(
  p05: number,
  p95: number,
  lo: number,
  hi: number,
): { brightness: number; contrast: number } {
  const spread = p95 - p05;
  // A flat image (spread ≈ 0) has no levels information to stretch; any gain we
  // solved would be an enormous, arbitrary amplification of noise.
  if (spread < 4) return { brightness: 0, contrast: 0 };

  const G = (hi - lo) / spread; // combined bK·cK
  const cK = (p05 * G + MID - lo) / MID;
  // A non-positive or absurd contrast solution means the inputs were degenerate.
  if (!Number.isFinite(cK) || cK <= 0.05) return { brightness: 0, contrast: 0 };
  const bK = G / cK;
  if (!Number.isFinite(bK) || bK <= 0) return { brightness: 0, contrast: 0 };

  // Clamp to a conservative envelope. Auto-enhance should tidy a photo, never
  // transform it — an aggressive stretch can bury exactly the pilling and
  // staining a condition-graded listing is obliged to show.
  return {
    brightness: clamp((clamp(bK, 0.75, 1.4) - 1) * 100, -25, 40),
    contrast: clamp((clamp(cK, 0.85, 1.5) - 1) * 100, -15, 50),
  };
}

// Auto-levels targets. These are where the 5th/95th PERCENTILES should land —
// not where the darkest and brightest pixels should land. A correctly exposed
// full-range photo already has p05 ≈ 16 and p95 ≈ 239, because 10% of its pixels
// sit outside that window by definition. Targeting 6/249 instead would tell
// every good photo it was 11% short on contrast, and Auto would never be a
// no-op on a photo that needed nothing.
const AUTO_BLACK = 16;
const AUTO_WHITE = 239;

/**
 * One-click enhancement: a levels stretch plus a grey-world white-balance
 * correction, returned as slider values the seller can then adjust.
 *
 * Saturation is deliberately left at 0 — pushing colour makes a garment look
 * better than it is, which is not a trade this product should make for them.
 */
export function autoAdjust(stats: ToneStats): Adjustments {
  if (stats.sampled === 0) return { ...NEUTRAL_ADJUSTMENTS };
  const { brightness, contrast } = solveLevels(
    stats.p05,
    stats.p95,
    AUTO_BLACK,
    AUTO_WHITE,
  );
  const wb = wbChannels(stats);
  // Target = neutral, i.e. red and blue equal.
  const warmth = clamp(solveWarmth(wb, { r: 1, b: 1 }), -40, 40);
  return clampAdjustments({
    ...NEUTRAL_ADJUSTMENTS,
    brightness,
    contrast,
    warmth,
  });
}

/**
 * Solve the adjustments that bring `source` into tonal agreement with
 * `reference` — the engine behind bulk tone matching.
 */
export function solveToneMatch(
  source: ToneStats,
  reference: ToneStats,
): Adjustments {
  if (source.sampled === 0 || reference.sampled === 0) {
    return { ...NEUTRAL_ADJUSTMENTS };
  }
  const { brightness, contrast } = solveLevels(
    source.p05,
    source.p95,
    reference.p05,
    reference.p95,
  );
  const warmth = clamp(
    solveWarmth(wbChannels(source), wbChannels(reference)),
    -50,
    50,
  );
  return clampAdjustments({
    ...NEUTRAL_ADJUSTMENTS,
    brightness,
    contrast,
    warmth,
  });
}

/**
 * How far apart two photos are tonally, in rough "slider units". Used to decide
 * whether a set even needs matching, and to pick the most representative photo
 * as the default reference.
 */
export function toneDistance(a: ToneStats, b: ToneStats): number {
  const lumaGap = Math.abs(a.meanLuma - b.meanLuma);
  const wbA = wbChannels(a);
  const wbB = wbChannels(b);
  const ratioA = wbA.b > 0 ? wbA.r / wbA.b : 1;
  const ratioB = wbB.b > 0 ? wbB.r / wbB.b : 1;
  // A 10% red/blue ratio gap reads about as different as 12 levels of exposure,
  // so scale the ratio term to put both on a comparable footing.
  return lumaGap + Math.abs(ratioA - ratioB) * 120;
}

/**
 * Index of the most representative photo — the one with the smallest total
 * distance to all the others. That is a far better default reference than
 * "the first photo", which is just as likely to be the odd one out.
 */
export function pickReferenceIndex(all: ToneStats[]): number {
  if (all.length === 0) return 0;
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < all.length; i++) {
    let score = 0;
    const a = all[i]!;
    for (let j = 0; j < all.length; j++) {
      if (i !== j) score += toneDistance(a, all[j]!);
    }
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

// ── Pixel passes ────────────────────────────────────────────────────

/**
 * Apply warmth and sharpness in place. Brightness/contrast/saturation are NOT
 * handled here — they ride on `ctx.filter` via `filterString`, which the browser
 * does far faster.
 */
export function applyPixelPasses(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  a: Adjustments,
): void {
  if (a.warmth !== 0) applyWarmth(data, a.warmth);
  if (a.sharpness > 0) {
    unsharpMask(
      data,
      width,
      height,
      (a.sharpness / 100) * 1.5,
      sharpenRadius(width, height),
    );
  }
}

/**
 * Sharpening radius scaled to the image, so the on-screen preview predicts the
 * saved result. A fixed 1px radius would be a strong effect on a 900px preview
 * and almost invisible on the 4000px original the seller actually saves.
 */
export function sharpenRadius(width: number, height: number): number {
  return clamp(Math.round(Math.max(width, height) / 900), 1, 6);
}

/** Per-channel temperature shift: red up + blue down is warmer, and inverse. */
export function applyWarmth(data: Uint8ClampedArray, warmth: number): void {
  const rGain = 1 + warmth / WARMTH_SCALE;
  const bGain = 1 - warmth / WARMTH_SCALE;
  for (let i = 0; i + 2 < data.length; i += 4) {
    data[i] = data[i]! * rGain;
    data[i + 2] = data[i + 2]! * bGain;
  }
}

/**
 * Unsharp mask: out = in + amount·(in − blur(in)).
 *
 * The blur is three passes of a separable box blur, which converges on a
 * Gaussian and costs O(n) per pass rather than O(n·r²) for a true convolution —
 * fast enough to run on a full-resolution photo at save time.
 */
export function unsharpMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
  radius = 1,
): void {
  if (amount <= 0 || width < 3 || height < 3) return;
  const blurred = new Uint8ClampedArray(data);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurHorizontal(blurred, width, height, radius);
    boxBlurVertical(blurred, width, height, radius);
  }
  for (let i = 0; i + 2 < data.length; i += 4) {
    // Alpha (i+3) is deliberately untouched — sharpening a cut-out's edge mask
    // would fringe it.
    data[i] = data[i]! + amount * (data[i]! - blurred[i]!);
    data[i + 1] = data[i + 1]! + amount * (data[i + 1]! - blurred[i + 1]!);
    data[i + 2] = data[i + 2]! + amount * (data[i + 2]! - blurred[i + 2]!);
  }
}

function boxBlurHorizontal(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  r: number,
): void {
  const row = new Uint8ClampedArray(width * 4);
  for (let y = 0; y < height; y++) {
    const base = y * width * 4;
    row.set(data.subarray(base, base + width * 4));
    for (let x = 0; x < width; x++) {
      const from = Math.max(0, x - r);
      const to = Math.min(width - 1, x + r);
      const count = to - from + 1;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let k = from; k <= to; k++) {
        sr += row[k * 4]!;
        sg += row[k * 4 + 1]!;
        sb += row[k * 4 + 2]!;
      }
      const o = base + x * 4;
      data[o] = sr / count;
      data[o + 1] = sg / count;
      data[o + 2] = sb / count;
    }
  }
}

function boxBlurVertical(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  r: number,
): void {
  const col = new Uint8ClampedArray(height * 4);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const o = (y * width + x) * 4;
      col[y * 4] = data[o]!;
      col[y * 4 + 1] = data[o + 1]!;
      col[y * 4 + 2] = data[o + 2]!;
    }
    for (let y = 0; y < height; y++) {
      const from = Math.max(0, y - r);
      const to = Math.min(height - 1, y + r);
      const count = to - from + 1;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let k = from; k <= to; k++) {
        sr += col[k * 4]!;
        sg += col[k * 4 + 1]!;
        sb += col[k * 4 + 2]!;
      }
      const o = (y * width + x) * 4;
      data[o] = sr / count;
      data[o + 1] = sg / count;
      data[o + 2] = sb / count;
    }
  }
}

// ── Canvas helpers (browser only) ───────────────────────────────────

/**
 * Run the pixel passes over a canvas that has already been drawn with
 * `filterString` applied. No-ops when the adjustments need no pixel work, so
 * callers can invoke it unconditionally.
 */
export function applyPixelPassesToCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  a: Adjustments,
): void {
  if (!needsPixelPass(a) || width === 0 || height === 0) return;
  const img = ctx.getImageData(0, 0, width, height);
  applyPixelPasses(img.data, width, height, a);
  ctx.putImageData(img, 0, 0);
}

/**
 * Draw `source` at its native size with `a` applied, and hand back the canvas.
 *
 * This is the geometry-free path used by bulk tone matching. The photo editor
 * has its own renderer because it also has to compose rotation, straightening
 * and the cover-scale that keeps straightened corners opaque.
 */
export function renderAdjustedCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
  a: Adjustments,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", {
    willReadFrequently: needsPixelPass(a),
  }) as CanvasRenderingContext2D;
  ctx.save();
  ctx.filter = filterString(a);
  ctx.drawImage(source, 0, 0, width, height);
  ctx.restore();
  applyPixelPassesToCanvas(ctx, width, height, a);
  return canvas;
}

/** Read tone stats straight off a canvas. */
export function analyzeCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): ToneStats {
  if (width === 0 || height === 0) return analyzeTone(new Uint8ClampedArray(0));
  return analyzeTone(ctx.getImageData(0, 0, width, height).data);
}
