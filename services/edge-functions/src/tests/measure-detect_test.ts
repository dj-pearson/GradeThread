// US-1572: the pure-TS MeasureCard detector vs REAL OpenCV ground truth.
//
// scripts/generate-measure-fixtures.py renders deterministic card scenes and
// records OpenCV ArUco's detections in manifest.json. These tests assert our
// detector (lib/measure-detect.ts) agrees with OpenCV — same ids, centers
// within a couple of pixels — and that calibrateMeasurePhoto's quality gates
// fire the RIGHT failure on the bad fixtures. This is the "validated against
// OpenCV outputs" contract from the story: the TS port cannot drift silently.
//
//   deno test --allow-read src/tests/measure-detect_test.ts

import { assert, assertEquals } from "@std/assert";
import { Image } from "imagescript";
import {
  applyHomography,
  calibrateMeasurePhoto,
  detectMarkers,
  fitHomography,
  type GrayImage,
} from "../lib/measure-detect.ts";
import { MEASURE_CARD_V1, MEASURE_CARD_VERSIONS } from "../lib/measure-card.ts";

interface FixtureMarker {
  id: number;
  center: [number, number];
  corners: Array<[number, number]>;
}
interface Fixture {
  name: string;
  file: string;
  expect: "calibrates" | "fails";
  note: string;
  width: number;
  height: number;
  opencv: FixtureMarker[];
}

const DIR = new URL("./fixtures/measure-card/", import.meta.url);
const manifest = JSON.parse(
  await Deno.readTextFile(new URL("manifest.json", DIR)),
) as { fixtures: Fixture[] };

async function loadGray(file: string): Promise<GrayImage> {
  const bytes = await Deno.readFile(new URL(file, DIR));
  const img = await Image.decode(bytes);
  const gray = new Uint8Array(img.width * img.height);
  for (let y = 1; y <= img.height; y++) {
    for (let x = 1; x <= img.width; x++) {
      // ImageScript is 1-indexed; pixels are 0xRRGGBBAA ints.
      const px = img.getPixelAt(x, y) >>> 0;
      const r = (px >>> 24) & 0xff, g = (px >>> 16) & 0xff, b = (px >>> 8) & 0xff;
      gray[(y - 1) * img.width + (x - 1)] = (r * 299 + g * 587 + b * 114) / 1000;
    }
  }
  return { width: img.width, height: img.height, gray };
}

const good = manifest.fixtures.filter((f) => f.expect === "calibrates");
const bad = manifest.fixtures.filter((f) => f.expect === "fails");
assert(good.length >= 4 && bad.length >= 2, "fixture set incomplete");

for (const f of good) {
  Deno.test(`detector agrees with OpenCV on ${f.name} (${f.note})`, async () => {
    const img = await loadGray(f.file);
    const markers = detectMarkers(img, MEASURE_CARD_VERSIONS);
    const ourIds = markers.map((m) => m.id).sort((a, b) => a - b);
    const cvIds = f.opencv.map((m) => m.id).sort((a, b) => a - b);
    assertEquals(ourIds, cvIds, "id sets must match OpenCV");
    // Centers within 3px of OpenCV's.
    for (const cv of f.opencv) {
      const ours = markers.find((m) => m.id === cv.id)!;
      const dist = Math.hypot(
        ours.center[0] - cv.center[0],
        ours.center[1] - cv.center[1],
      );
      assert(
        dist <= 3,
        `id ${cv.id} center off by ${dist.toFixed(2)}px (ours ${ours.center}, cv ${cv.center})`,
      );
    }
  });

  Deno.test(`calibration succeeds on ${f.name} and maps true inch geometry`, async () => {
    const img = await loadGray(f.file);
    const res = calibrateMeasurePhoto(img, MEASURE_CARD_VERSIONS);
    assert(res.ok, `expected calibration, got ${!res.ok ? res.reason : ""}`);
    assertEquals(res.cardVersion, 1);
    // The fitted homography must map OPENCV's centers (independent ground
    // truth) onto the card's known inch coordinates.
    for (const cv of f.opencv) {
      const [ix, iy] = applyHomography(res.homography, cv.center[0], cv.center[1]);
      const [ex, ey] = MEASURE_CARD_V1.markerCentersInches[String(cv.id)];
      const err = Math.hypot(ix - ex, iy - ey);
      assert(err <= 0.05, `id ${cv.id} maps ${err.toFixed(3)}in off (${ix},${iy})`);
    }
    assert(res.quality.reprojResidualIn <= 0.06);
    assert(res.ppi > 5, "ppi must be a plausible positive scale");
  });
}

Deno.test("straight-on ppi recovers the render scale (~110 dpi)", async () => {
  const f = good.find((x) => x.name === "straight-on")!;
  const img = await loadGray(f.file);
  const res = calibrateMeasurePhoto(img, MEASURE_CARD_VERSIONS);
  assert(res.ok);
  assert(
    Math.abs(res.ppi - 110) <= 2.2,
    `ppi ${res.ppi.toFixed(2)} should be ~110 (±2%)`,
  );
});

Deno.test("occluded marker fails as card_not_fully_visible", async () => {
  const f = bad.find((x) => x.name === "occluded-marker")!;
  const img = await loadGray(f.file);
  const res = calibrateMeasurePhoto(img, MEASURE_CARD_VERSIONS);
  assert(!res.ok);
  assertEquals(res.reason, "card_not_fully_visible");
  assert(res.message.length > 10, "carries a user-facing remediation");
});

Deno.test("heavy blur fails closed (never a fake calibration)", async () => {
  const f = bad.find((x) => x.name === "blurred")!;
  const img = await loadGray(f.file);
  const res = calibrateMeasurePhoto(img, MEASURE_CARD_VERSIONS);
  assert(!res.ok, "blurred photo must not calibrate");
  assert(
    ["photo_too_blurry", "card_not_fully_visible", "card_not_found"].includes(
      res.reason,
    ),
    res.reason,
  );
});

Deno.test("fitHomography round-trips a known projective warp", () => {
  // Synthetic sanity independent of any fixture.
  const H = [1.2, 0.1, 30, -0.05, 0.9, 12, 0.0002, 0.0001, 1];
  const src: Array<[number, number]> = [
    [10, 10], [400, 20], [420, 300], [15, 280], [200, 150], [90, 240],
  ];
  const dst = src.map(([x, y]) => applyHomography(H, x, y));
  const fit = fitHomography(src, dst)!;
  for (const [x, y] of src) {
    const a = applyHomography(H, x, y);
    const b = applyHomography(fit, x, y);
    assert(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6);
  }
});
