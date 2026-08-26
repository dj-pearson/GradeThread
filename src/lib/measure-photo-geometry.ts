// US-2888: what happens to a MeasureCard calibration when the photo it was
// measured on is rotated, and how a seller gets a line back that has ended up
// outside the frame.
//
// THE BUG THIS EXISTS TO CLOSE. `item_photos.measure_calibration` holds two
// things, and both are expressed in the pixel coordinates of the stored image:
// a homography (image px -> card-plane inches) and the endpoints of every
// measurement line. Rotating the photo replaces those pixels with a differently
// shaped image and nothing rewrote either. The homography then measured along
// the wrong axis, and an endpoint at x=3000 in a picture 2000 wide rendered
// past the right edge of the SVG -- present, saveable, and impossible to grab,
// because the only way to move an endpoint was to drag it.
//
// A quarter turn is a rigid motion, so nothing has to be re-detected: inches
// are preserved, and both halves of the calibration can be carried across
// exactly. That is the whole idea here. Anything that is NOT a quarter turn --
// a crop, a straighten -- resamples the frame, and this module says so rather
// than guessing; the caller clears the calibration and the editor re-detects
// the card, which it already does unprompted.
//
// Pure and dependency-free so the cases live in a unit test rather than in a
// browser.

import type { PhotoEditRecipe } from "@/lib/photo-edit-recipe";

export type Point = [number, number];

/** Clockwise quarter turns. 1 = 90 degrees clockwise, matching the editor's rotate button. */
export type Quarter = 0 | 1 | 2 | 3;

/** A stored measurement line, as it sits in `measure_calibration.lines`. */
export interface StoredMeasureLine {
  e1: Point;
  e2: Point;
  inches: number;
  label: string;
}

/** The parts of a stored calibration this module rewrites. */
export interface RotatableCalibration {
  homography: number[];
  lines?: Record<string, StoredMeasureLine>;
  [key: string]: unknown;
}

// ── Quarter turns ───────────────────────────────────────────────────────────

/** Image dimensions after `turns` clockwise quarter turns. */
export function rotatedDims(w: number, h: number, turns: Quarter): [number, number] {
  return turns % 2 === 0 ? [w, h] : [h, w];
}

/**
 * Where a source pixel lands after `turns` clockwise quarter turns.
 *
 * Derived from what the editor's canvas actually does -- translate to the
 * centre, `ctx.rotate(+deg)`, draw at `-sw/2, -sh/2` -- not from a convention,
 * because a sign error here is a silently mirrored measurement rather than a
 * crash. `w`/`h` are the SOURCE dimensions.
 */
export function rotatePointQuarter(
  p: Point,
  turns: Quarter,
  w: number,
  h: number,
): Point {
  const [x, y] = p;
  switch (turns) {
    case 1:
      return [h - y, x];
    case 2:
      return [w - x, h - y];
    case 3:
      return [y, w - x];
    default:
      return [x, y];
  }
}

/** Row-major 3x3 product. */
export function matMul3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k]! * b[k * 3 + c]!;
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

/**
 * The affine that takes a ROTATED pixel back to its source pixel, row-major.
 *
 * This is the inverse of `rotatePointQuarter`, and it is the piece the
 * homography needs: `H` reads source pixels, so composing it with "new pixel ->
 * source pixel" gives a homography that reads the rotated image and returns the
 * same inches.
 */
export function quarterInverseAffine(turns: Quarter, w: number, h: number): number[] {
  switch (turns) {
    case 1:
      return [0, 1, 0, -1, 0, h, 0, 0, 1];
    case 2:
      return [-1, 0, w, 0, -1, h, 0, 0, 1];
    case 3:
      return [0, -1, w, 1, 0, 0, 0, 0, 1];
    default:
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
}

/** The same homography, reading the rotated image. `w`/`h` are the SOURCE dims. */
export function rotateHomographyQuarter(
  homography: number[],
  turns: Quarter,
  w: number,
  h: number,
): number[] {
  if (turns === 0) return [...homography];
  return matMul3(homography, quarterInverseAffine(turns, w, h));
}

/**
 * Carry a whole calibration across a quarter turn.
 *
 * `ppi`, `quality` and `cardVersion` are untouched on purpose: a rotation
 * changes no distance, so the reading is exactly as good as it was. Only the
 * two things expressed in pixels move.
 */
export function rotateCalibrationQuarter<T extends RotatableCalibration>(
  calib: T,
  turns: Quarter,
  w: number,
  h: number,
): T {
  if (turns === 0) return calib;
  const lines = calib.lines;
  const nextLines = lines
    ? Object.fromEntries(
        Object.entries(lines).map(([key, l]) => [
          key,
          {
            ...l,
            e1: rotatePointQuarter(l.e1, turns, w, h),
            e2: rotatePointQuarter(l.e2, turns, w, h),
          },
        ]),
      )
    : undefined;
  return {
    ...calib,
    homography: rotateHomographyQuarter(calib.homography, turns, w, h),
    ...(nextLines ? { lines: nextLines } : {}),
  };
}

// ── Reading a pair of edit recipes ──────────────────────────────────────────

/** Degrees -> quarter turns, for a value the recipe parser has already snapped. */
function quarterOf(degrees: number): Quarter {
  return ((((Math.round(degrees / 90) % 4) + 4) % 4) as Quarter);
}

/** True when a recipe's geometry is nothing but a quarter turn. */
function isPureQuarterTurn(r: PhotoEditRecipe | null): boolean {
  if (!r) return true; // no recipe at all: the stored image IS the original
  return r.fine === 0 && r.crop === null;
}

/**
 * How the stored image moves between two saves of the editor, when that is
 * expressible as a quarter turn.
 *
 * Recipes are ABSOLUTE against the preserved original, never deltas, so the
 * turn that matters is the difference between them. `null` means the change
 * resamples the frame -- a crop or a straighten on either side -- and the
 * caller must invalidate rather than transform. Tone and background removal are
 * ignored deliberately: neither moves a pixel.
 */
export function quarterTurnBetween(
  prev: PhotoEditRecipe | null,
  next: PhotoEditRecipe | null,
): Quarter | null {
  if (!isPureQuarterTurn(prev) || !isPureQuarterTurn(next)) return null;
  const from = prev ? quarterOf(prev.rotation) : 0;
  const to = next ? quarterOf(next.rotation) : 0;
  return (((to - from) % 4) + 4) % 4 as Quarter;
}

/** What a photo edit should do to the calibration stored on that photo. */
export type CalibrationEditOutcome =
  /** Geometry is untouched (tone only) — leave the stored value alone. */
  | { action: "keep" }
  /** A quarter turn: the calibration carries across exactly, no re-detection. */
  | { action: "rotate"; turns: Quarter; calibration: RotatableCalibration }
  /**
   * The frame was resampled, or we don't know the dimensions to rotate about.
   * The stored calibration describes pixels that no longer exist, so it is
   * cleared and the card is detected again — which the editor does unprompted.
   */
  | { action: "clear"; reason: "resampled" | "unknown-dimensions" };

/**
 * Decide what happens to `item_photos.measure_calibration` when new pixels are
 * written over a photo.
 *
 * Called for every photo edit, and answers "keep" for the overwhelming
 * majority of them, because most photos carry no calibration at all.
 */
export function calibrationAfterPhotoEdit(input: {
  calibration: RotatableCalibration | null | undefined;
  prevRecipe: PhotoEditRecipe | null;
  nextRecipe: PhotoEditRecipe | null;
  /** Dimensions of the image the calibration was measured on. */
  width: number | null | undefined;
  height: number | null | undefined;
}): CalibrationEditOutcome {
  const calib = input.calibration;
  if (!calib || !Array.isArray(calib.homography)) return { action: "keep" };
  const turns = quarterTurnBetween(input.prevRecipe, input.nextRecipe);
  if (turns === null) return { action: "clear", reason: "resampled" };
  if (turns === 0) return { action: "keep" };
  const w = input.width;
  const h = input.height;
  if (!w || !h || w <= 0 || h <= 0) {
    return { action: "clear", reason: "unknown-dimensions" };
  }
  return {
    action: "rotate",
    turns,
    calibration: rotateCalibrationQuarter(calib, turns, w, h),
  };
}

// ── Getting a line back ─────────────────────────────────────────────────────

/** Whether both endpoints sit inside the image. */
export function lineWithinBounds(
  e1: Point,
  e2: Point,
  w: number,
  h: number,
): boolean {
  return [e1, e2].every(
    ([x, y]) => x >= 0 && y >= 0 && x <= w && y <= h,
  );
}

/**
 * Slide a line by (dx, dy) as ONE object.
 *
 * The translation is clamped, never the endpoints. Clamping each endpoint on
 * its own is what turns a drag near the edge into a shortened, re-angled line
 * -- the measurement changes while the seller is only trying to reposition it.
 * Here the segment keeps its exact length and angle and simply stops at the
 * wall.
 */
export function translateLine(
  e1: Point,
  e2: Point,
  dx: number,
  dy: number,
  w: number,
  h: number,
): { e1: Point; e2: Point } {
  const minX = Math.min(e1[0], e2[0]);
  const maxX = Math.max(e1[0], e2[0]);
  const minY = Math.min(e1[1], e2[1]);
  const maxY = Math.max(e1[1], e2[1]);
  // The window of deltas that leaves the whole segment inside. It is EMPTY when
  // the segment is longer than the frame along that axis, and an empty window
  // must not be clamped into -- doing so would freeze the line in place, which
  // is the same dead end as the off-screen endpoint. Move it freely instead and
  // let recenterLine be the thing that shrinks.
  const lowX = -minX;
  const highX = w - maxX;
  const lowY = -minY;
  const highY = h - maxY;
  const cdx = lowX <= highX ? Math.max(lowX, Math.min(highX, dx)) : dx;
  const cdy = lowY <= highY ? Math.max(lowY, Math.min(highY, dy)) : dy;
  return {
    e1: [e1[0] + cdx, e1[1] + cdy],
    e2: [e2[0] + cdx, e2[1] + cdy],
  };
}

/**
 * Pull a line that is partly or wholly outside the image back into view,
 * keeping its length and angle.
 *
 * Translation first, because that is the answer that changes no measurement.
 * Only a line too long to fit is shrunk, and then about its own midpoint so it
 * stays on the same landmark.
 */
export function recenterLine(
  e1: Point,
  e2: Point,
  w: number,
  h: number,
): { e1: Point; e2: Point } {
  const slid = translateLine(e1, e2, 0, 0, w, h);
  let a = slid.e1;
  let b = slid.e2;
  // translateLine with a zero delta still clamps the segment into the frame
  // when it started outside it, because the allowed range collapses onto the
  // offending edge. What it cannot fix is a segment longer than the frame.
  const spanX = Math.abs(a[0] - b[0]);
  const spanY = Math.abs(a[1] - b[1]);
  const shrink = Math.min(
    1,
    spanX > w ? w / spanX : 1,
    spanY > h ? h / spanY : 1,
  );
  if (shrink < 1) {
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    a = [mx + (a[0] - mx) * shrink, my + (a[1] - my) * shrink];
    b = [mx + (b[0] - mx) * shrink, my + (b[1] - my) * shrink];
    const re = translateLine(a, b, 0, 0, w, h);
    a = re.e1;
    b = re.e2;
  }
  return { e1: a, e2: b };
}

/**
 * Distance from a DISPLAY-space point to the body of a segment, in display px.
 * Returns the distance and how far along the segment the foot of the
 * perpendicular sits (0..1), so a caller can refuse a hit that is really on an
 * endpoint.
 */
export function distanceToSegment(
  p: Point,
  a: Point,
  b: Point,
): { distance: number; t: number } {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { distance: Math.hypot(p[0] - a[0], p[1] - a[1]), t: 0 };
  const raw = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  const t = Math.max(0, Math.min(1, raw));
  const cx = a[0] + t * vx;
  const cy = a[1] + t * vy;
  return { distance: Math.hypot(p[0] - cx, p[1] - cy), t };
}

/**
 * Which line's BODY a display-space pointer grabs, or null.
 *
 * `endpointRadius` carves the ends out of the hit area so the endpoints keep
 * winning where they overlap -- resizing has to stay the easier gesture on a
 * short line, or a seller aiming at a circle would move the whole line instead.
 */
export function hitLineBody(
  lines: readonly { e1: Point; e2: Point }[],
  displayPt: Point,
  scale: number,
  tolerance = 10,
  endpointRadius = 14,
): number | null {
  let best: number | null = null;
  let bestD = tolerance;
  lines.forEach((line, index) => {
    const a: Point = [line.e1[0] * scale, line.e1[1] * scale];
    const b: Point = [line.e2[0] * scale, line.e2[1] * scale];
    const { distance, t } = distanceToSegment(displayPt, a, b);
    if (distance > bestD) return;
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segLen > 0) {
      const fromStart = t * segLen;
      const fromEnd = segLen - fromStart;
      if (fromStart < endpointRadius || fromEnd < endpointRadius) return;
    }
    bestD = distance;
    best = index;
  });
  return best;
}

// ── Which way is up, according to the card ──────────────────────────────────

/** Row-major 3x3 inverse, or null when the matrix is singular. */
export function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as [
    number, number, number, number, number, number, number, number, number,
  ];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

function applyH(h: number[], x: number, y: number): Point {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  return [
    (h[0]! * x + h[1]! * y + h[2]!) / w,
    (h[3]! * x + h[4]! * y + h[5]!) / w,
  ];
}

/**
 * How many clockwise quarter turns bring the photo upright, read off the card.
 *
 * The MeasureCard's four fiducials carry DIFFERENT ids in a known clockwise
 * order, so the homography is uniquely oriented -- there is no four-fold
 * ambiguity to resolve and no guessing about which edge is the top. Mapping the
 * card's own x-axis back into the image says where "along the card, left to
 * right" points on screen; the turn that puts it pointing right is the turn
 * that puts the card, and therefore the flat-lay shot beside it, the way up the
 * card is printed.
 *
 * Returns 0 for an unreadable homography, which is the safe answer: no
 * rotation offered rather than a wrong one.
 */
export function cardUprightQuarter(homography: number[]): Quarter {
  if (homography.length !== 9) return 0;
  const inv = invert3(homography);
  if (!inv) return 0;
  const origin = applyH(inv, 0, 0);
  const along = applyH(inv, 1, 0);
  const dx = along[0] - origin[0];
  const dy = along[1] - origin[1];
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  if (dx === 0 && dy === 0) return 0;
  // Screen y grows downward, so this angle is already measured clockwise, and
  // a clockwise quarter turn adds 90 to it. Solve for the turn that lands on 0.
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return ((((-Math.round(degrees / 90) % 4) + 4) % 4) as Quarter);
}

/** Human phrasing for a turn, for a button label and a toast. */
export function quarterLabel(turns: Quarter): string {
  switch (turns) {
    case 1:
      return "a quarter turn right";
    case 2:
      return "upside down";
    case 3:
      return "a quarter turn left";
    default:
      return "already upright";
  }
}
