// US-1577: the buyer-facing measurements photo — a CARD-FREE, UNBRANDED
// render of the measurement shot with each saved measurement drawn as a line
// with end-caps and an inch label.
//
// eBay-policy: plain lines + numbers ONLY. No GradeThread logo, wordmark,
// URL, or QR — third-party marks / off-eBay promotion get listings hidden
// (same rule family as the no-links pivot). Annotated measurement photos
// themselves are established eBay practice.
//
// Card removal is DETERMINISTIC, not inpainting: the capture protocol puts
// the card BESIDE the garment, so the card's pixel bbox (its inch-bounds
// mapped through the inverse calibration homography) can be cropped away by
// picking the largest image rectangle that excludes it. When that crop would
// clip the garment's measurement lines, we fall back to masking the card
// region with a flat background fill. Pure geometry helpers are exported for
// tests; the ImageScript rendering is isolated in renderMeasureOverlay.

import { Image } from "imagescript";
import type { MeasureCardGeometry } from "./measure-card.ts";
import { applyHomography } from "./measure-detect.ts";

export interface OverlayLine {
  key: string;
  label: string;
  /** Endpoints in ORIGINAL-image pixels (from extract / the editor). */
  e1: [number, number];
  e2: [number, number];
  /** Display value in inches (the item's saved measurement wins upstream). */
  inches: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Palette: neutral, unbranded annotation colors (0xRRGGBBAA).
const LINE = 0x111827ff; // near-black slate
const HALO = 0xffffffff;
const PILL_BG = 0xffffffee;
const PILL_TEXT = 0x111827ff;

/** Invert a row-major 3x3 homography (adjugate / determinant). */
export function invertHomography(h: number[]): number[] | null {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i,
    B = c * i - b * j,
    C = b * f - c * e,
    D = f * g - d * j,
    E = a * j - c * g,
    F = c * d - a * f,
    G = d * i - e * g,
    H2 = b * g - a * i,
    I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-12) return null;
  return [A, B, C, D, E, F, G, H2, I].map((v) => v / det);
}

/** The card's pixel-space bounding box via the INVERSE calibration homography. */
export function cardBBoxPx(
  homography: number[],
  card: MeasureCardGeometry,
  pad = 0.15,
): Rect | null {
  const inv = invertHomography(homography);
  if (!inv) return null;
  const cornersIn: Array<[number, number]> = [
    [-pad, -pad],
    [card.cardInches.w + pad, -pad],
    [card.cardInches.w + pad, card.cardInches.h + pad],
    [-pad, card.cardInches.h + pad],
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [ix, iy] of cornersIn) {
    const [px, py] = applyHomography(inv, ix, iy);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Largest of the four guillotine rectangles (left/right/above/below the card
 * bbox) — the crop that removes the card. Null when every candidate is tiny
 * (card mid-frame) → caller falls back to masking.
 */
export function chooseCropRect(
  imageW: number,
  imageH: number,
  card: Rect,
): Rect | null {
  // Each candidate's CONSTRAINED dimension (the one the card eats into) must
  // keep >= 35% of its axis, or the "crop" is a useless sliver.
  const cands: Array<{ r: Rect; frac: number }> = [
    {
      r: { x: 0, y: 0, w: Math.max(0, card.x), h: imageH }, // left of card
      frac: Math.max(0, card.x) / imageW,
    },
    {
      r: {
        x: Math.min(imageW, card.x + card.w),
        y: 0,
        w: Math.max(0, imageW - (card.x + card.w)),
        h: imageH,
      }, // right
      frac: Math.max(0, imageW - (card.x + card.w)) / imageW,
    },
    {
      r: { x: 0, y: 0, w: imageW, h: Math.max(0, card.y) }, // above
      frac: Math.max(0, card.y) / imageH,
    },
    {
      r: {
        x: 0,
        y: Math.min(imageH, card.y + card.h),
        w: imageW,
        h: Math.max(0, imageH - (card.y + card.h)),
      }, // below
      frac: Math.max(0, imageH - (card.y + card.h)) / imageH,
    },
  ];
  let best: Rect | null = null;
  for (const { r, frac } of cands) {
    if (frac < 0.35) continue;
    if (r.w < 50 || r.h < 50) continue;
    if (!best || r.w * r.h > best.w * best.h) best = r;
  }
  return best;
}

/** True when both endpoints of a line sit inside the rect (small margin). */
export function lineInsideRect(line: OverlayLine, r: Rect, margin = 4): boolean {
  const inside = (p: [number, number]) =>
    p[0] >= r.x - margin && p[0] <= r.x + r.w + margin &&
    p[1] >= r.y - margin && p[1] <= r.y + r.h + margin;
  return inside(line.e1) && inside(line.e2);
}

/** Format the label text: `Chest 22¼"`-style with vulgar fractions. */
export function formatInches(label: string, inches: number): string {
  const whole = Math.floor(inches);
  const frac = Math.round((inches - whole) * 4);
  const fracs = ["", "1/4", "1/2", "3/4"];
  const num = frac === 0
    ? `${whole}`
    : whole === 0
    ? fracs[frac]
    : `${whole} ${fracs[frac]}`;
  return `${label}: ${num} in`;
}

function drawThickLine(
  img: Image,
  p1: [number, number],
  p2: [number, number],
  thickness: number,
  color: number,
): void {
  const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const steps = Math.max(2, Math.ceil(len));
  const half = Math.max(1, Math.round(thickness / 2));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(p1[0] + (p2[0] - p1[0]) * t);
    const y = Math.round(p1[1] + (p2[1] - p1[1]) * t);
    const bx = Math.max(1, x - half);
    const by = Math.max(1, y - half);
    if (bx > img.width - thickness || by > img.height - thickness) continue;
    img.drawBox(bx, by, thickness, thickness, color);
  }
}

function drawEndCap(
  img: Image,
  at: [number, number],
  dir: [number, number],
  size: number,
  color: number,
): void {
  const len = Math.hypot(dir[0], dir[1]) || 1;
  // Perpendicular bar.
  const px = -dir[1] / len, py = dir[0] / len;
  drawThickLine(
    img,
    [at[0] - px * size, at[1] - py * size],
    [at[0] + px * size, at[1] + py * size],
    Math.max(2, Math.round(size / 3)),
    color,
  );
}

export interface RenderInput {
  image: Image;
  lines: OverlayLine[];
  /** Crop that excludes the card, or null to mask the card region instead. */
  crop: Rect | null;
  /** Card bbox in the ORIGINAL image (for the mask fallback). */
  cardBox: Rect | null;
  font: Uint8Array;
}

/**
 * Render the annotated, card-free measurements photo. Returns encoded JPEG.
 * Only lines fully inside the output frame are drawn (never a dangling
 * half-line). Throws when NO line survives — the caller degrades gracefully.
 */
export async function renderMeasureOverlay(
  input: RenderInput,
): Promise<Uint8Array> {
  let img = input.image.clone();

  let frame: Rect = { x: 0, y: 0, w: img.width, h: img.height };
  if (input.crop) {
    const c = input.crop;
    const x = Math.max(0, Math.round(c.x));
    const y = Math.max(0, Math.round(c.y));
    const w = Math.min(img.width - x, Math.round(c.w));
    const h = Math.min(img.height - y, Math.round(c.h));
    img = img.crop(x, y, w, h);
    frame = { x, y, w, h };
  } else if (input.cardBox) {
    // Mask fallback: flat-fill the card region with the pixel just outside
    // its top-left corner (matte/table tone) — deterministic, no inpainting.
    const cb = input.cardBox;
    const sx = Math.min(
      img.width,
      Math.max(1, Math.round(cb.x) - 5),
    );
    const sy = Math.min(img.height, Math.max(1, Math.round(cb.y) - 5));
    const fill = img.getPixelAt(sx, sy);
    const x = Math.max(1, Math.round(cb.x));
    const y = Math.max(1, Math.round(cb.y));
    const w = Math.min(img.width - x, Math.round(cb.w) + 1);
    const h = Math.min(img.height - y, Math.round(cb.h) + 1);
    if (w > 0 && h > 0) img.drawBox(x, y, w, h, fill);
  }

  // Draw each line that fits the frame, in frame-local coordinates.
  const drawn: Array<{ line: OverlayLine; m: [number, number] }> = [];
  for (const line of input.lines) {
    if (input.crop && !lineInsideRect(line, frame)) continue;
    const a: [number, number] = [line.e1[0] - frame.x, line.e1[1] - frame.y];
    const b: [number, number] = [line.e2[0] - frame.x, line.e2[1] - frame.y];
    const dir: [number, number] = [b[0] - a[0], b[1] - a[1]];
    const capSize = Math.max(6, Math.round(Math.min(img.width, img.height) * 0.012));
    // White halo under the ink so the line reads on any garment color.
    drawThickLine(img, a, b, 7, HALO);
    drawEndCap(img, a, dir, capSize + 2, HALO);
    drawEndCap(img, b, dir, capSize + 2, HALO);
    drawThickLine(img, a, b, 3, LINE);
    drawEndCap(img, a, dir, capSize, LINE);
    drawEndCap(img, b, dir, capSize, LINE);
    drawn.push({ line, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  if (drawn.length === 0) {
    throw new Error("no measurement lines fit the card-free frame");
  }

  // Labels last so they sit on top of every line.
  const fontSize = Math.max(16, Math.round(Math.min(img.width, img.height) * 0.028));
  for (const { line, m } of drawn) {
    const text = formatInches(line.label, line.inches);
    const textImg = await Image.renderText(input.font, fontSize, text, PILL_TEXT);
    const padX = Math.round(fontSize * 0.45);
    const padY = Math.round(fontSize * 0.25);
    const pw = textImg.width + padX * 2;
    const ph = textImg.height + padY * 2;
    let lx = Math.round(m[0] - pw / 2);
    let ly = Math.round(m[1] - ph - 8);
    lx = Math.max(1, Math.min(img.width - pw - 1, lx));
    ly = Math.max(1, Math.min(img.height - ph - 1, ly));
    img.drawBox(lx, ly, pw, ph, PILL_BG);
    img.composite(textImg, lx + padX, ly + padY);
  }

  return await img.encodeJPEG(88);
}
