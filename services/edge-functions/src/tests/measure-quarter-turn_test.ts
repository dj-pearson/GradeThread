// US-2890: the server-side quarter-turn math.
//
// src/test/measure-quarter-turn-parity.test.ts already proves this file reads
// identically to the browser copy. That is a claim about the TEXT. These are
// the claims about the NUMBERS, and they are made here rather than trusted to
// the web suite because the web suite runs under Vite and this code runs under
// Deno: a divergence in how the two runtimes handle a negative zero out of
// Math.atan2 would pass a text comparison and still mirror a measurement.
//
// The point map is checked against the canvas transform longhand rather than
// against a convention, for the reason the source says: a sign error here is a
// silently mirrored measurement, not a crash.

import { assertEquals } from "@std/assert";
import {
  cardUprightQuarter,
  matMul3,
  type Point,
  type Quarter,
  quarterInverseAffine,
  quarterLabel,
  rotateCalibrationQuarter,
  rotatedDims,
  rotateHomographyQuarter,
  rotatePointQuarter,
} from "../lib/measure-quarter-turn.ts";

const W = 400;
const H = 300;

/**
 * What the editor's canvas actually does, written out longhand: translate to
 * the centre of the DESTINATION, rotate clockwise by the angle, draw the source
 * centred on the origin. Independent of the implementation under test, which is
 * the only reason it is worth asserting against.
 */
function canvasMap(p: Point, turns: Quarter, w: number, h: number): Point {
  const [dw, dh] = turns % 2 === 0 ? [w, h] : [h, w];
  const rad = (turns * Math.PI) / 2;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  // Source pixel relative to the source centre.
  const sx = p[0] - w / 2;
  const sy = p[1] - h / 2;
  // Clockwise rotation in screen coordinates (y down).
  const rx = sx * cos - sy * sin;
  const ry = sx * sin + sy * cos;
  return [rx + dw / 2, ry + dh / 2];
}

function close(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

Deno.test("rotatedDims swaps only on an odd turn", () => {
  assertEquals(rotatedDims(W, H, 0), [W, H]);
  assertEquals(rotatedDims(W, H, 1), [H, W]);
  assertEquals(rotatedDims(W, H, 2), [W, H]);
  assertEquals(rotatedDims(W, H, 3), [H, W]);
});

Deno.test("rotatePointQuarter matches the canvas transform for every turn", () => {
  const samples: Point[] = [[0, 0], [W, 0], [0, H], [W, H], [37, 211], [399, 1]];
  for (const turns of [0, 1, 2, 3] as Quarter[]) {
    for (const p of samples) {
      const got = rotatePointQuarter(p, turns, W, H);
      const want = canvasMap(p, turns, W, H);
      assertEquals(
        close(got[0], want[0]) && close(got[1], want[1]),
        true,
        `turn ${turns} on ${JSON.stringify(p)}: got ${JSON.stringify(got)}, canvas says ${
          JSON.stringify(want)
        }`,
      );
    }
  }
});

Deno.test("four quarter turns return every point to itself", () => {
  let p: Point = [123, 45];
  let [w, h] = [W, H];
  for (let i = 0; i < 4; i++) {
    p = rotatePointQuarter(p, 1, w, h);
    [w, h] = rotatedDims(w, h, 1);
  }
  assertEquals(p, [123, 45]);
  assertEquals([w, h], [W, H]);
});

Deno.test("a rotated point lands inside the rotated frame", () => {
  // The bug US-2888 existed to close: an endpoint at x=3000 in a picture that
  // is now 2000 wide. Every corner of the source must land on a corner of the
  // destination, never outside it.
  for (const turns of [1, 2, 3] as Quarter[]) {
    const [dw, dh] = rotatedDims(W, H, turns);
    for (const p of [[0, 0], [W, 0], [0, H], [W, H]] as Point[]) {
      const [x, y] = rotatePointQuarter(p, turns, W, H);
      assertEquals(x >= 0 && x <= dw && y >= 0 && y <= dh, true, `turn ${turns} sent ${p} to ${x},${y}`);
    }
  }
});

Deno.test("quarterInverseAffine really inverts the point map", () => {
  for (const turns of [0, 1, 2, 3] as Quarter[]) {
    const A = quarterInverseAffine(turns, W, H);
    for (const p of [[10, 20], [W, H], [0, H]] as Point[]) {
      const r = rotatePointQuarter(p, turns, W, H);
      const backX = A[0]! * r[0] + A[1]! * r[1] + A[2]!;
      const backY = A[3]! * r[0] + A[4]! * r[1] + A[5]!;
      assertEquals(close(backX, p[0]) && close(backY, p[1]), true, `turn ${turns} round trip on ${p}`);
    }
  }
});

Deno.test("a rotated homography reports the SAME inches for the same physical point", () => {
  // The whole justification for carrying rather than re-detecting: a quarter
  // turn is a rigid motion, so the reading is unchanged.
  const H0 = [0.02, 0, -1.5, 0, 0.02, -2.5, 0, 0, 1];
  const src: Point = [250, 140];
  const inchesBefore = [
    (H0[0]! * src[0] + H0[1]! * src[1] + H0[2]!),
    (H0[3]! * src[0] + H0[4]! * src[1] + H0[5]!),
  ];
  for (const turns of [1, 2, 3] as Quarter[]) {
    const H1 = rotateHomographyQuarter(H0, turns, W, H);
    const moved = rotatePointQuarter(src, turns, W, H);
    const after = [
      (H1[0]! * moved[0] + H1[1]! * moved[1] + H1[2]!),
      (H1[3]! * moved[0] + H1[4]! * moved[1] + H1[5]!),
    ];
    assertEquals(
      close(after[0]!, inchesBefore[0]!, 1e-9) && close(after[1]!, inchesBefore[1]!, 1e-9),
      true,
      `turn ${turns}: ${JSON.stringify(inchesBefore)} became ${JSON.stringify(after)}`,
    );
  }
});

Deno.test("matMul3 is the identity against the identity", () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const M = [2, 3, 5, 7, 11, 13, 17, 19, 23];
  assertEquals(matMul3(M, I), M);
  assertEquals(matMul3(I, M), M);
});

Deno.test("rotateCalibrationQuarter moves the lines and leaves the reading alone", () => {
  const calib = {
    homography: [0.02, 0, -1.5, 0, 0.02, -2.5, 0, 0, 1],
    ppi: 50,
    cardVersion: 1,
    lines: {
      chest: { e1: [20, 30] as Point, e2: [220, 30] as Point, inches: 20, label: "Chest" },
    },
  };
  const out = rotateCalibrationQuarter(calib, 1, W, H);
  // ppi and cardVersion are untouched: a rotation changes no distance.
  assertEquals(out.ppi, 50);
  assertEquals(out.cardVersion, 1);
  // The inches on the line are untouched too - the endpoints move, the
  // measurement does not.
  assertEquals(out.lines.chest.inches, 20);
  assertEquals(out.lines.chest.e1, rotatePointQuarter([20, 30], 1, W, H));
  assertEquals(out.lines.chest.e2, rotatePointQuarter([220, 30], 1, W, H));
});

Deno.test("a zero turn returns the calibration untouched", () => {
  const calib = { homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], lines: {} };
  assertEquals(rotateCalibrationQuarter(calib, 0, W, H), calib);
});

Deno.test("cardUprightQuarter reads an upright card as needing no turn", () => {
  // Card +x maps to image +x: already upright.
  assertEquals(cardUprightQuarter([0.02, 0, -1.5, 0, 0.02, -2.5, 0, 0, 1]), 0);
});

Deno.test("cardUprightQuarter names the turn that puts a sideways card upright", () => {
  // Build a homography for a card lying at each quarter, by taking an upright
  // one and rotating the FRAME under it. The turn it reports must be the turn
  // that undoes what was done.
  const upright = [0.02, 0, -1.5, 0, 0.02, -2.5, 0, 0, 1];
  for (const applied of [1, 2, 3] as Quarter[]) {
    const rotated = rotateHomographyQuarter(upright, applied, W, H);
    const reported = cardUprightQuarter(rotated);
    assertEquals(
      (applied + reported) % 4,
      0,
      `a card turned ${applied} should need ${(4 - applied) % 4} back, got ${reported}`,
    );
  }
});

Deno.test("cardUprightQuarter declines rather than guesses on a singular homography", () => {
  // All-zero rows: no inverse. Reporting 0 means "do nothing", which is the
  // correct failure for a pass that rewrites a seller's photo.
  assertEquals(cardUprightQuarter([0, 0, 0, 0, 0, 0, 0, 0, 0]), 0);
  assertEquals(cardUprightQuarter([1, 2, 3]), 0);
});

Deno.test("quarterLabel says something a seller would recognise", () => {
  assertEquals(quarterLabel(0), "already upright");
  assertEquals(quarterLabel(1), "a quarter turn right");
  assertEquals(quarterLabel(2), "upside down");
  assertEquals(quarterLabel(3), "a quarter turn left");
});
