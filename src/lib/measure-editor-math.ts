// US-1574: pure math for the measurement overlay editor. Kept out of the
// component so the px↔inch mapping, hit-testing, and default placements are
// unit-tested and shared by spec with the iOS/Android ports (US-1575/76).
// The homography (image px → card-plane inches) comes from the US-1572
// calibration stored on the measurement photo.

export type Point = [number, number];

export interface EditorLine {
  key: string;
  label: string;
  /** Endpoints in ORIGINAL image pixels (the calibration's coordinate space). */
  e1: Point;
  e2: Point;
}

/** Apply a row-major 3x3 homography. Mirror of the edge implementation. */
export function applyHomography(h: number[], x: number, y: number): Point {
  // Calibration homographies are always 9 elements (noUncheckedIndexedAccess).
  const w = h[6]! * x + h[7]! * y + h[8]!;
  return [
    (h[0]! * x + h[1]! * y + h[2]!) / w,
    (h[3]! * x + h[4]! * y + h[5]!) / w,
  ];
}

export function roundQuarterInch(v: number): number {
  return Math.round(v * 4) / 4;
}

/** Card-plane inches between two ORIGINAL-px endpoints, 0.25in steps. */
export function inchesBetween(h: number[], e1: Point, e2: Point): number {
  const a = applyHomography(h, e1[0], e1[1]);
  const b = applyHomography(h, e2[0], e2[1]);
  return roundQuarterInch(Math.hypot(a[0] - b[0], a[1] - b[1]));
}

/** `22.25` → `22¼`, `0.5` → `½` — compact chip text. */
export function formatQuarter(v: number): string {
  const whole = Math.floor(v);
  const frac = Math.round((v - whole) * 4);
  const glyph = ["", "¼", "½", "¾"][frac] ?? "";
  if (frac === 0) return String(whole);
  return whole === 0 ? glyph : `${whole}${glyph}`;
}

/** Uniform display scale that fits the image inside maxW×maxH (never >1 upscale). */
export function fitScale(
  imgW: number,
  imgH: number,
  maxW: number,
  maxH: number,
): number {
  if (imgW <= 0 || imgH <= 0) return 1;
  return Math.min(1, maxW / imgW, maxH / imgH);
}

export interface EndpointHit {
  lineIndex: number;
  end: "e1" | "e2";
}

/**
 * Which endpoint (if any) a DISPLAY-space pointer position grabs. Radius is
 * in display px; original-px endpoints are compared through `scale`.
 */
export function hitEndpoint(
  lines: EditorLine[],
  displayPt: Point,
  scale: number,
  radius = 14,
): EndpointHit | null {
  let best: EndpointHit | null = null;
  let bestD = radius;
  lines.forEach((line, lineIndex) => {
    for (const end of ["e1", "e2"] as const) {
      const p = line[end];
      const d = Math.hypot(p[0] * scale - displayPt[0], p[1] * scale - displayPt[1]);
      if (d <= bestD) {
        bestD = d;
        best = { lineIndex, end };
      }
    }
  });
  return best;
}

// Keys that read as vertical measurements on a flat-lay; everything else
// defaults horizontal.
const VERTICAL_KEYS = new Set(["length", "inseam", "rise", "sleeve", "insole"]);

/**
 * A sensible starting line for a measurement the auto pass didn't place —
 * centered, 40% of the image span, along the key's natural axis. The user
 * drags it into position; this only needs to be grabbable.
 */
export function defaultLinePlacement(
  key: string,
  imgW: number,
  imgH: number,
): { e1: Point; e2: Point } {
  const cx = imgW / 2;
  const cy = imgH / 2;
  if (VERTICAL_KEYS.has(key)) {
    const span = imgH * 0.4;
    return { e1: [cx, cy - span / 2], e2: [cx, cy + span / 2] };
  }
  const span = imgW * 0.4;
  return { e1: [cx - span / 2, cy], e2: [cx + span / 2, cy] };
}

// ── US-2686: moving an endpoint without a pointer ───────────────────────────
//
// The editor positions endpoints with a pointer drag on an SVG. A drag has no
// keyboard equivalent and no screen-reader equivalent, so a keyboard-only user
// could not set a measurement at all. The web answer is a keyboard model —
// focus an endpoint, arrow keys to move — rather than iOS's four nudge buttons,
// because those are a touch answer to the same gap (US-2534).
//
// THE STEP RULE IS SHARED WITH iOS and is deliberately identical to
// ios/GradeThread/Measure/MeasureNudge.swift. Two clients that disagree about
// what one press moves are two clients whose corrections cannot be compared,
// and the correction deltas are logged. src/test/fixtures/measure-editor-math-cases.json
// carries the cases; src/lib/__tests__/measure-editor-math.test.ts asserts them
// and separately asserts that the Swift file still spells the same formula.
//
// ANDROID DOES NOT IMPLEMENT NUDGE YET and therefore does not read those
// fixture sections — MeasureGeometryTest.kt pulls named sections rather than
// iterating the file, so this adds nothing there. When Android grows a keyboard
// or switch-access path, the sections are already waiting.

/** How far one nudge moves an endpoint, in ORIGINAL image pixels. */
export function nudgeStep(imgW: number, imgH: number): number {
  // Proportional to the SHORT edge rather than a fixed count, so one press
  // covers the same fraction of the garment on a 1600px phone photo and a
  // 4000px camera one. A fixed 8px would be a visible step on the first and
  // imperceptible on the second, turning "nudge until it lines up" into forty
  // presses.
  const short = Math.min(imgW, imgH);
  // Floored at 1: a step of zero is a control that reports success and moves
  // nothing, which is worse than no control.
  if (!Number.isFinite(short) || short <= 0) return 1;
  return Math.max(1, Math.round(short * 0.005));
}

/**
 * The coarse step, for holding Shift.
 *
 * A whole multiple of the fine step, not a second formula. "Shift is five
 * nudges" is a sentence a user can hold; two independently-derived numbers is
 * a thing they have to discover.
 */
export const NUDGE_COARSE_MULTIPLE = 5;

/** Screen directions. `down` increases y because these are top-left-origin image px. */
export type NudgeDirection = "left" | "right" | "up" | "down";

const NUDGE_DELTA: Record<NudgeDirection, Point> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

/**
 * Move `point` one step in `direction`, clamped inside the image.
 *
 * CLAMPED, not refused — the same thing the drag path does. Refusing would
 * leave someone pressing a key that silently does nothing near the border,
 * with no way to tell that from a bug.
 */
export function nudged(
  point: Point,
  direction: NudgeDirection,
  step: number,
  imgW: number,
  imgH: number,
): Point {
  const [dx, dy] = NUDGE_DELTA[direction];
  return [
    Math.max(0, Math.min(imgW, point[0] + dx * step)),
    Math.max(0, Math.min(imgH, point[1] + dy * step)),
  ];
}
