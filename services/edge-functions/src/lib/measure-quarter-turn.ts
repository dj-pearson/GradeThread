// US-2890: the server's half of US-2888's quarter-turn math.
//
// US-2888 made "Turn upright" one press in the measurements panel: the
// MeasureCard's four fiducials carry different ids in a known clockwise order,
// so the calibration homography already knows which way the card is lying, and
// a quarter turn is a rigid motion, so the calibration carries across exactly
// rather than being re-detected. All of that lives in
// src/lib/measure-photo-geometry.ts, which is browser TypeScript compiled by
// Vite and cannot be imported by a Deno service.
//
// So this is the same math, in the runtime that runs at intake. It is a
// DELIBERATE second copy of eight small pure functions, and the thing that
// stops the two drifting is src/test/measure-quarter-turn-parity.test.ts, which
// reads both files and compares the function bodies rather than trusting a
// comment. A copy with no such test is how the two ends of a rounding rule end
// up half a pixel apart and nobody finds out for a year.
//
// Why not move the shared math to a package both can import: the frontend
// build has no path into services/, the edge has no path into src/, and the
// repo has no shared workspace today. Introducing one for eight functions is a
// bigger change than this story is, and it would be the wrong commit to bury it
// in. If a third caller ever appears, that is the moment.
//
// Pure and dependency-free, so its cases live in a unit test rather than behind
// an image decoder.

/** Clockwise quarter turns. 1 = 90 degrees clockwise. */
export type Quarter = 0 | 1 | 2 | 3;

export type Point = [number, number];

/** A stored measurement line, as it sits in `measure_calibration.lines`. */
export interface StoredMeasureLine {
  e1: Point;
  e2: Point;
  inches: number;
  label: string;
}

/** The parts of a stored calibration a quarter turn rewrites. */
export interface RotatableCalibration {
  homography: number[];
  lines?: Record<string, StoredMeasureLine>;
  [key: string]: unknown;
}

/** Image dimensions after `turns` clockwise quarter turns. */
export function rotatedDims(w: number, h: number, turns: Quarter): [number, number] {
  return turns % 2 === 0 ? [w, h] : [h, w];
}

/**
 * Where a source pixel lands after `turns` clockwise quarter turns.
 *
 * `w`/`h` are the SOURCE dimensions. A sign error here is a silently mirrored
 * measurement rather than a crash, which is why the test checks these against
 * the canvas transform longhand instead of against a convention.
 */
export function rotatePointQuarter(p: Point, turns: Quarter, w: number, h: number): Point {
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
 * The inverse of `rotatePointQuarter`, and the piece the homography needs: `H`
 * reads source pixels, so composing it with "new pixel -> source pixel" gives a
 * homography that reads the rotated image and returns the same inches.
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

/** Row-major 3x3 inverse, or null when the matrix is singular. */
export function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
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
 * How many clockwise quarter turns put the CARD upright in the frame.
 *
 * The card's own +x axis is walked back into pixel space through the inverse
 * homography, and the answer is the turn that lands that axis pointing right.
 * No detection, no model call, and right by construction rather than guessed
 * from the garment's shape - which is the whole reason the card is the
 * reference and not the clothing.
 *
 * Returns 0 for a homography that cannot be inverted, which reads as "already
 * upright" and therefore as "do nothing". Declining to act on a reading it does
 * not trust is the correct failure for a pass that rewrites a seller's photo.
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
  // Screen y grows downward, so this angle is already measured clockwise, and a
  // clockwise quarter turn adds 90 to it. Solve for the turn that lands on 0.
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return ((((-Math.round(degrees / 90) % 4) + 4) % 4) as Quarter);
}

/** Human phrasing for a turn, for a toast and an audit line. */
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
