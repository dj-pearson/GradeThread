// US-536: one-tap auto-enhance for AutoLister photos. Pure-canvas (no model,
// no API): auto-crop to the subject, gray-world white balance, and percentile
// auto-levels for brightness/contrast — turning mixed phone snaps into a
// cohesive studio set. For multi-angle consistency, a group's photos share one
// EnhanceStats (computed once from the cover) so they get the same white-point
// and exposure.
//
// The pixel math (analyzeStats / applyAdjust / detectSubjectBBox) is pure and
// unit-tested; the canvas glue (autoEnhance) decodes, crops, applies, encodes.

export interface EnhanceStats {
  // Gray-world white-balance channel gains.
  gainR: number;
  gainG: number;
  gainB: number;
  // Auto-levels endpoints (0..255) from the luminance histogram.
  black: number;
  white: number;
}

export interface ProcessedImage {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  contentType: "image/jpeg";
  ext: "jpg";
}

const MAX_EDGE = 2400;
const THUMB_EDGE = 320;
const ANALYZE_EDGE = 512; // detection/stats run on a downscale for speed
const GAIN_MIN = 0.7;
const GAIN_MAX = 1.4;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Gray-world white balance + percentile auto-levels from RGBA pixels. Pure.
 * Gains are clamped so a strongly-tinted shot can't be pushed to absurdity;
 * black/white come from the 1st/99th luminance percentiles.
 */
export function analyzeStats(data: Uint8ClampedArray): EnhanceStats {
  const n = data.length / 4;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    sumR += r;
    sumG += g;
    sumB += b;
    // Rec. 601 luma, integer-rounded for the histogram bucket.
    const y = (r * 299 + g * 587 + b * 114) / 1000;
    hist[Math.min(255, Math.max(0, Math.round(y)))]!++;
  }
  const meanR = sumR / n || 1;
  const meanG = sumG / n || 1;
  const meanB = sumB / n || 1;
  const gray = (meanR + meanG + meanB) / 3;
  const gainR = clamp(gray / meanR, GAIN_MIN, GAIN_MAX);
  const gainG = clamp(gray / meanG, GAIN_MIN, GAIN_MAX);
  const gainB = clamp(gray / meanB, GAIN_MIN, GAIN_MAX);

  const lowCount = n * 0.01;
  const highCount = n * 0.99;
  let cum = 0;
  let black = 0;
  let white = 255;
  for (let v = 0; v < 256; v++) {
    cum += hist[v]!;
    if (black === 0 && cum >= lowCount) black = v;
    if (cum >= highCount) {
      white = v;
      break;
    }
  }
  if (white - black < 8) {
    // Degenerate (flat) histogram — don't stretch.
    black = 0;
    white = 255;
  }
  return { gainR, gainG, gainB, black, white };
}

/** Apply white-balance gains then auto-levels to RGBA pixels, in place. Pure. */
export function applyAdjust(data: Uint8ClampedArray, s: EnhanceStats): void {
  const span = s.white - s.black || 255;
  const scale = 255 / span;
  // Per-channel LUTs so the inner loop is just three lookups.
  const lut = (gain: number): Uint8ClampedArray => {
    const t = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      t[v] = clamp((v * gain - s.black) * scale, 0, 255);
    }
    return t;
  };
  const lr = lut(s.gainR);
  const lg = lut(s.gainG);
  const lb = lut(s.gainB);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lr[data[i]!]!;
    data[i + 1] = lg[data[i + 1]!]!;
    data[i + 2] = lb[data[i + 2]!]!;
  }
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding box of the subject vs. a uniform-ish background, estimated from the
 * four corners. Returns a box (with a small margin) in the coordinate space of
 * the w×h buffer, or the full frame when no clear subject stands out. Pure.
 */
export function detectSubjectBBox(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): BBox {
  // Background estimate: average the four corner pixels.
  const corner = (cx: number, cy: number): [number, number, number] => {
    const i = (cy * w + cx) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };
  const corners = [
    corner(0, 0),
    corner(w - 1, 0),
    corner(0, h - 1),
    corner(w - 1, h - 1),
  ];
  const bg: [number, number, number] = [
    corners.reduce((a, c) => a + c[0], 0) / 4,
    corners.reduce((a, c) => a + c[1], 0) / 4,
    corners.reduce((a, c) => a + c[2], 0) / 4,
  ];
  const THRESH = 42; // color distance to count a pixel as "subject"
  const rowHits = new Array<number>(h).fill(0);
  const colHits = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dr = data[i]! - bg[0];
      const dg = data[i + 1]! - bg[1];
      const db = data[i + 2]! - bg[2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) > THRESH) {
        rowHits[y]!++;
        colHits[x]!++;
      }
    }
  }
  const rowMin = Math.max(2, w * 0.02); // a row/col needs this many subject px
  const colMin = Math.max(2, h * 0.02);
  let top = 0;
  let bottom = h - 1;
  let left = 0;
  let right = w - 1;
  while (top < h && rowHits[top]! < rowMin) top++;
  while (bottom > top && rowHits[bottom]! < rowMin) bottom--;
  while (left < w && colHits[left]! < colMin) left++;
  while (right > left && colHits[right]! < colMin) right--;

  // No clear subject (blank or full-frame) — don't crop.
  if (right - left < w * 0.1 || bottom - top < h * 0.1) {
    return { x: 0, y: 0, w, h };
  }
  const marginX = Math.round(w * 0.03);
  const marginY = Math.round(h * 0.03);
  const x = Math.max(0, left - marginX);
  const y = Math.max(0, top - marginY);
  const x2 = Math.min(w - 1, right + marginX);
  const y2 = Math.min(h - 1, bottom + marginY);
  return { x, y, w: x2 - x + 1, h: y2 - y + 1 };
}

function fitScale(w: number, h: number, maxEdge: number): number {
  return Math.min(1, maxEdge / Math.max(w, h));
}

function canvasFor(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true })! };
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      quality,
    ),
  );
}

/**
 * Auto-enhance one image. If `reference` stats are supplied (a group's cover),
 * they are applied for a consistent white-point/exposure instead of analyzing
 * this photo independently. Returns the encoded image plus the stats used, so a
 * caller can thread the cover's stats through the rest of an item's photos.
 */
export async function autoEnhance(
  input: Blob,
  reference?: EnhanceStats,
): Promise<{ image: ProcessedImage; stats: EnhanceStats }> {
  const bitmap = await createImageBitmap(input);
  try {
    // Full-res working buffer (downscaled to MAX_EDGE).
    const fScale = fitScale(bitmap.width, bitmap.height, MAX_EDGE);
    const fw = Math.max(1, Math.round(bitmap.width * fScale));
    const fh = Math.max(1, Math.round(bitmap.height * fScale));
    const full = canvasFor(fw, fh);
    full.ctx.drawImage(bitmap, 0, 0, fw, fh);

    // Small buffer for detection + stats.
    const aScale = fitScale(fw, fh, ANALYZE_EDGE);
    const aw = Math.max(1, Math.round(fw * aScale));
    const ah = Math.max(1, Math.round(fh * aScale));
    const small = canvasFor(aw, ah);
    small.ctx.drawImage(full.canvas, 0, 0, aw, ah);
    const smallData = small.ctx.getImageData(0, 0, aw, ah).data;

    const stats = reference ?? analyzeStats(smallData);

    // Subject bbox detected on the small buffer, scaled to full-res.
    const sb = detectSubjectBBox(smallData, aw, ah);
    const inv = aScale > 0 ? 1 / aScale : 1;
    const cx = Math.round(sb.x * inv);
    const cy = Math.round(sb.y * inv);
    const cw = Math.min(fw - cx, Math.round(sb.w * inv));
    const ch = Math.min(fh - cy, Math.round(sb.h * inv));

    // Crop to subject.
    const crop = canvasFor(Math.max(1, cw), Math.max(1, ch));
    crop.ctx.drawImage(full.canvas, cx, cy, cw, ch, 0, 0, cw, ch);

    // Color-correct the cropped pixels.
    const cropData = crop.ctx.getImageData(0, 0, crop.canvas.width, crop.canvas.height);
    applyAdjust(cropData.data, stats);
    crop.ctx.putImageData(cropData, 0, 0);

    const fullBlob = await toJpeg(crop.canvas, 0.92);

    // Thumbnail from the corrected crop.
    const tScale = fitScale(crop.canvas.width, crop.canvas.height, THUMB_EDGE);
    const tw = Math.max(1, Math.round(crop.canvas.width * tScale));
    const th = Math.max(1, Math.round(crop.canvas.height * tScale));
    const thumbCanvas = canvasFor(tw, th);
    thumbCanvas.ctx.drawImage(crop.canvas, 0, 0, tw, th);
    const thumbBlob = await toJpeg(thumbCanvas.canvas, 0.8);

    return {
      image: {
        full: fullBlob,
        thumb: thumbBlob,
        width: crop.canvas.width,
        height: crop.canvas.height,
        contentType: "image/jpeg",
        ext: "jpg",
      },
      stats,
    };
  } finally {
    bitmap.close();
  }
}
