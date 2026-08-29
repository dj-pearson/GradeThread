#!/usr/bin/env node
// US-2889 AC5: one fixture file, read by three implementations.
//
// The quarter-turn math now exists in three places and will exist in three
// places for as long as the product has three clients: TypeScript for the
// browser (src/lib/measure-photo-geometry.ts), TypeScript for Deno at intake
// (services/edge-functions/src/lib/measure-quarter-turn.ts), and Swift for iOS.
// US-2890 made the first two agree by comparing their SOURCE, which works only
// because both are TypeScript. Swift cannot be compared that way.
//
// So the third client is held to the same numbers instead of the same text.
// This script generates the cases from the browser implementation, which is the
// original and the one US-2888's own tests already pin, and each client asserts
// against the generated JSON. A divergence then shows up as a failing case with
// coordinates in it, in whichever client drifted.
//
// WHY GENERATED RATHER THAN HAND-WRITTEN. A hand-written expectation is a
// fourth implementation, written by whoever was least careful that day, and
// when it disagrees with the code nobody can tell which one is wrong. Generated
// from the reference, the file has exactly one meaning: this is what the
// browser does today.
//
// Regenerating it is therefore a DECISION, not a chore. If a case changes, the
// browser's behaviour changed, and that belongs in a commit message.
//
// Run: node scripts/gen-quarter-turn-fixture.mjs
// Out: assets/measure-card/quarter-turn-cases.json

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "assets/measure-card/quarter-turn-cases.json");

// Imported through a file URL rather than a bare path: on Windows a bare
// absolute path is not a valid ESM specifier, and the failure ("Only URLs with
// a scheme in: file, data are supported") names neither the file nor the fix.
const geom = await import(
  pathToFileURL(resolve(ROOT, "src/lib/measure-photo-geometry.ts")).href
).catch(async () => {
  // The module is TypeScript. Under plain node it needs a loader; vite-node is
  // already a dev dependency and is what the repo's other script tests use.
  throw new Error(
    "Run this through vite-node: npx vite-node scripts/gen-quarter-turn-fixture.mjs",
  );
});

const {
  rotatedDims,
  rotatePointQuarter,
  quarterInverseAffine,
  rotateHomographyQuarter,
  cardUprightQuarter,
  lineWithinBounds,
  translateLine,
  recenterLine,
  distanceToSegment,
} = geom;

/**
 * Frames chosen to be asymmetric in both directions and to include a square
 * one. A square frame is the case where a wrong axis swap cannot be seen in the
 * dimensions, so it has to be caught by the coordinates.
 */
const FRAMES = [
  [400, 300],
  [300, 400],
  [256, 256],
  [4032, 3024],
];

/** Points off both axes of symmetry, plus all four corners and the centre. */
function pointsFor(w, h) {
  return [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
    [w / 2, h / 2],
    [Math.round(w * 0.17), Math.round(h * 0.83)],
    [Math.round(w * 0.91), Math.round(h * 0.06)],
  ];
}

/** A few plausible calibration homographies, including a tilted one. */
const HOMOGRAPHIES = [
  { label: "axis-aligned", h: [0.02, 0, -1.5, 0, 0.02, -2.5, 0, 0, 1] },
  { label: "tilted", h: [0.019, 0.004, -1.2, -0.004, 0.019, -2.1, 0, 0, 1] },
  { label: "perspective", h: [0.021, 0.001, -1.4, 0.002, 0.02, -2.6, 1e-5, 2e-5, 1] },
];

const cases = {
  dims: [],
  points: [],
  inverseAffine: [],
  homographies: [],
  upright: [],
  translate: [],
  recenter: [],
  segment: [],
};

for (const [w, h] of FRAMES) {
  for (const turns of [0, 1, 2, 3]) {
    cases.dims.push({ w, h, turns, expected: rotatedDims(w, h, turns) });
    cases.inverseAffine.push({ w, h, turns, expected: quarterInverseAffine(turns, w, h) });
    for (const p of pointsFor(w, h)) {
      cases.points.push({ w, h, turns, point: p, expected: rotatePointQuarter(p, turns, w, h) });
    }
    for (const { label, h: H } of HOMOGRAPHIES) {
      cases.homographies.push({
        label,
        w,
        h,
        turns,
        homography: H,
        expected: rotateHomographyQuarter(H, turns, w, h),
      });
    }
  }
}

// The upright reading, which is the piece with a sign in it that a port is most
// likely to get backwards. Built by rotating a known-upright card under the
// frame: the answer must be the turn that undoes what was applied.
for (const [w, h] of FRAMES) {
  for (const { label, h: H } of HOMOGRAPHIES) {
    for (const applied of [0, 1, 2, 3]) {
      const rotated = rotateHomographyQuarter(H, applied, w, h);
      cases.upright.push({
        label,
        w,
        h,
        applied,
        homography: rotated,
        expected: cardUprightQuarter(rotated),
      });
    }
  }
}

// US-2889 AC5 names the RECENTER math alongside the rotation, and it is the
// half with the interesting edges: a segment longer than the frame has no
// delta that leaves it inside, so translateLine deliberately does NOT clamp it
// (clamping into an empty range freezes the line, which is the same dead end as
// the off-screen endpoint), and recenterLine is the only thing that shrinks.
// A port that clamps unconditionally passes every ordinary case and fails only
// on the oversized one, so the oversized one is here.
const LINES = [
  { label: "inside", e1: [40, 40], e2: [240, 40] },
  { label: "diagonal", e1: [30, 200], e2: [280, 60] },
  { label: "partly-out-right", e1: [300, 50], e2: [520, 50] },
  { label: "wholly-out", e1: [700, 700], e2: [900, 760] },
  { label: "negative", e1: [-80, -40], e2: [60, -40] },
  { label: "longer-than-frame-x", e1: [-100, 150], e2: [900, 150] },
  { label: "longer-than-frame-y", e1: [150, -100], e2: [150, 900] },
  { label: "degenerate", e1: [100, 100], e2: [100, 100] },
];

const DELTAS = [[0, 0], [25, 0], [0, -25], [-400, 0], [1000, 1000]];

for (const [w, h] of FRAMES) {
  for (const L of LINES) {
    cases.recenter.push({
      label: L.label,
      w,
      h,
      e1: L.e1,
      e2: L.e2,
      within: lineWithinBounds(L.e1, L.e2, w, h),
      expected: recenterLine(L.e1, L.e2, w, h),
    });
    for (const [dx, dy] of DELTAS) {
      cases.translate.push({
        label: L.label,
        w,
        h,
        e1: L.e1,
        e2: L.e2,
        dx,
        dy,
        expected: translateLine(L.e1, L.e2, dx, dy, w, h),
      });
    }
  }
}

// distanceToSegment returns the parameter too, so a caller can refuse a hit
// that is really on an endpoint. Both halves are pinned.
for (const L of LINES) {
  for (const p of [[0, 0], [140, 40], [140, 90], [1000, 1000], [-50, 20]]) {
    const r = distanceToSegment(p, L.e1, L.e2);
    cases.segment.push({
      label: L.label,
      point: p,
      e1: L.e1,
      e2: L.e2,
      expected: { distance: r.distance, t: r.t },
    });
  }
}

const doc = {
  $comment:
    "US-2889 AC5. GENERATED by scripts/gen-quarter-turn-fixture.mjs from " +
    "src/lib/measure-photo-geometry.ts, which is the reference implementation. " +
    "Do not hand-edit: a hand-written expectation is a fourth implementation, " +
    "and when it disagrees with the code nobody can tell which is wrong. " +
    "Regenerating is a decision that belongs in a commit message.",
  source: "src/lib/measure-photo-geometry.ts",
  counts: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.length])),
  cases,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(
  `wrote ${OUT}\n  ` +
    Object.entries(doc.counts).map(([k, n]) => `${k}: ${n}`).join("\n  "),
);
