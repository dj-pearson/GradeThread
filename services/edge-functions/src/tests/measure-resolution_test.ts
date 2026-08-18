// US-2672: how few pixels the MeasureCard can be read at, and what it costs.
//
// The OpenCV-validated fixtures (measure-detect_test.ts) prove the detector
// agrees with a real ArUco implementation. They cannot answer the question that
// actually broke sellers, which is a question about a CURVE: as a garment gets
// bigger the card gets smaller in frame, so at what point does the calibration
// stop being trustworthy, and does the code refuse at that point or somewhere
// else? It refused somewhere else — at a 40px marker side, which was a proxy
// for accuracy standing in front of the real accuracy check, and which a
// correctly-shot 40px marker could not clear anyway because the gate measured a
// binarized blob a pixel short.
//
// So this file renders the card at a sweep of scales and asserts the curve.
// Synthetic on purpose: the point is the scale sweep, and OpenCV cannot be a
// dependency of the edge container.
//
//   deno test --allow-read src/tests/measure-resolution_test.ts

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { Image } from "imagescript";
import {
  calibrateMeasurePhoto,
  laplacianVariance,
  markersRoi,
  MAX_REPROJ_RESIDUAL_IN,
  MIN_BLUR_SCORE,
  MIN_MARKER_SIDE_PX,
  SOFT_MARKER_SIDE_PX,
  type GrayImage,
} from "../lib/measure-detect.ts";
import { MEASURE_CARD_V1, MEASURE_CARD_VERSIONS } from "../lib/measure-card.ts";
import { detectRungs, toGray } from "../lib/measure-calibrate.ts";

const CARD = MEASURE_CARD_V1;

/**
 * Render the card at `ppi` onto a flat "table", 4x supersampled so the edges
 * are antialiased the way a lens gives them, then softened and grained. A
 * pixel-exact render would flatter the detector at small sizes.
 */
function renderCard(opts: {
  ppi: number;
  padIn?: number;
  softenPasses?: number;
  noise?: number;
  seed?: number;
}): GrayImage {
  const { ppi } = opts;
  const pad = Math.round(ppi * (opts.padIn ?? 1.2));
  const SS = 4;
  const cw = Math.round(CARD.cardInches.w * ppi);
  const ch = Math.round(CARD.cardInches.h * ppi);
  const W = cw + pad * 2, H = ch + pad * 2;
  const hi = new Uint8Array(W * SS * H * SS).fill(170); // table
  const put = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H * SS, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(W * SS, Math.round(x1)); x++) {
        hi[y * W * SS + x] = v;
      }
    }
  };
  put(pad * SS, pad * SS, (pad + cw) * SS, (pad + ch) * SS, 245); // card stock
  for (const id of CARD.markerIds) {
    const [cx, cy] = CARD.markerCentersInches[String(id)];
    const side = CARD.markerSizeInches * ppi * SS;
    const ox = (pad + (cx - CARD.markerSizeInches / 2) * ppi) * SS;
    const oy = (pad + (cy - CARD.markerSizeInches / 2) * ppi) * SS;
    const mod = side / 7;
    const bits = CARD.markerBits[String(id)];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const white = isBorder ? false : bits[r - 1][c - 1] === 1;
        put(ox + c * mod, oy + r * mod, ox + (c + 1) * mod, oy + (r + 1) * mod, white ? 245 : 18);
      }
    }
  }
  let buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) acc += hi[(y * SS + dy) * W * SS + (x * SS + dx)];
      }
      buf[y * W + x] = Math.round(acc / (SS * SS));
    }
  }
  for (let p = 0; p < (opts.softenPasses ?? 1); p++) {
    const out = new Uint8Array(W * H);
    const g = (xx: number, yy: number) =>
      buf[Math.min(H - 1, Math.max(0, yy)) * W + Math.min(W - 1, Math.max(0, xx))];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        out[y * W + x] = Math.round(
          (g(x - 1, y) + g(x + 1, y) + g(x, y - 1) + g(x, y + 1) + 4 * g(x, y)) / 8,
        );
      }
    }
    buf = out;
  }
  let s = (opts.seed ?? 7) >>> 0;
  const n = opts.noise ?? 6;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    buf[i] = Math.max(0, Math.min(255, Math.round(buf[i] + ((s >>> 16) / 65535 - 0.5) * 2 * n)));
  }
  return { width: W, height: H, gray: buf };
}

// ── The curve ───────────────────────────────────────────────────────

Deno.test("calibrates all the way down to the declared floor", () => {
  for (const markerPx of [20, 24, 32, 48, 80, 110]) {
    for (const seed of [3, 11, 29]) {
      const img = renderCard({ ppi: markerPx / CARD.markerSizeInches, seed });
      const res = calibrateMeasurePhoto(img, MEASURE_CARD_VERSIONS);
      assert(
        res.ok,
        `${markerPx}px marker (seed ${seed}) should calibrate, got ${!res.ok ? res.reason : ""}`,
      );
    }
  }
});

Deno.test("recovers the true scale at the floor, not just at generous sizes", () => {
  // The whole argument for lowering MIN_MARKER_SIDE_PX is that the SCALE is
  // still right down there. If this drifts, the floor has to go back up.
  for (const markerPx of [20, 24, 32, 48, 110]) {
    const ppi = markerPx / CARD.markerSizeInches;
    const res = calibrateMeasurePhoto(renderCard({ ppi }), MEASURE_CARD_VERSIONS);
    assert(res.ok);
    const errPct = Math.abs((res.ppi - ppi) / ppi) * 100;
    assert(errPct < 0.5, `${markerPx}px marker: ppi off by ${errPct.toFixed(2)}%`);
    assert(
      res.quality.reprojResidualIn < MAX_REPROJ_RESIDUAL_IN / 2,
      `${markerPx}px marker: residual ${res.quality.reprojResidualIn.toFixed(4)}in`,
    );
  }
});

Deno.test("a 40px marker measures 40px", () => {
  // It used to measure 39: the side came off the binarized blob's outermost
  // BLACK PIXEL CENTRES, half a pixel short on each side, so a card shot at
  // exactly the old 40px gate was rejected by it.
  for (const markerPx of [24, 40, 60, 110]) {
    const res = calibrateMeasurePhoto(
      renderCard({ ppi: markerPx / CARD.markerSizeInches }),
      MEASURE_CARD_VERSIONS,
    );
    assert(res.ok);
    assertAlmostEquals(
      res.quality.minMarkerSidePx,
      markerPx,
      0.75,
      `a ${markerPx}px marker measured ${res.quality.minMarkerSidePx.toFixed(2)}px`,
    );
  }
});

Deno.test("small-but-readable is a flag, not a refusal", () => {
  const small = calibrateMeasurePhoto(
    renderCard({ ppi: 24 / CARD.markerSizeInches }),
    MEASURE_CARD_VERSIONS,
  );
  assert(small.ok);
  assertEquals(small.quality.lowResolution, true);
  // And it says how fine a distinction the photo can express, which is the
  // thing a seller measuring to a quarter inch actually needs to know.
  assert(small.quality.inchesPerPx! < 0.05, `${small.quality.inchesPerPx}in per px`);

  const big = calibrateMeasurePhoto(
    renderCard({ ppi: 110 / CARD.markerSizeInches }),
    MEASURE_CARD_VERSIONS,
  );
  assert(big.ok);
  assertEquals(big.quality.lowResolution, false);
  assert(big.quality.minMarkerSidePx >= SOFT_MARKER_SIDE_PX);
});

Deno.test("below the floor it fails closed, and never with a bogus scale", () => {
  for (const markerPx of [8, 12, 16]) {
    const res = calibrateMeasurePhoto(
      renderCard({ ppi: markerPx / CARD.markerSizeInches }),
      MEASURE_CARD_VERSIONS,
    );
    assert(!res.ok, `${markerPx}px marker must not calibrate`);
    assert(
      ["card_not_found", "card_not_fully_visible", "markers_too_small"].includes(res.reason),
      `${markerPx}px marker failed as ${res.reason}`,
    );
  }
  assert(MIN_MARKER_SIDE_PX <= 20, "the floor this file measured is 20px");
});

// ── Blur is a property of the card, not of the frame ─────────────────

Deno.test("a sharp card in a mostly-flat frame is not called blurry", () => {
  // The large-garment shape: the card is sharp, but it occupies a sliver of a
  // frame that is otherwise flat fabric and flat floor. Scoring the WHOLE frame
  // let that emptiness outvote the card and produced "this photo is too blurry
  // to measure from" on a photo that was in focus.
  const card = renderCard({ ppi: 40 / CARD.markerSizeInches, padIn: 0.4 });
  const W = 1800, H = 1400;
  const gray = new Uint8Array(W * H).fill(150);
  let s = 99 >>> 0;
  for (let i = 0; i < gray.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    gray[i] = Math.max(0, Math.min(255, 150 + Math.round(((s >>> 16) / 65535 - 0.5) * 4)));
  }
  const ox = 60, oy = H - card.height - 60;
  for (let y = 0; y < card.height; y++) {
    for (let x = 0; x < card.width; x++) gray[(oy + y) * W + (ox + x)] = card.gray[y * card.width + x];
  }
  const scene: GrayImage = { width: W, height: H, gray };

  const wholeFrame = laplacianVariance(scene);
  assert(
    wholeFrame < MIN_BLUR_SCORE,
    `this scene only tests something if the frame-wide score is under the gate (got ${wholeFrame.toFixed(1)})`,
  );

  const res = calibrateMeasurePhoto(scene, MEASURE_CARD_VERSIONS);
  assert(res.ok, `expected a calibration, got ${!res.ok ? res.reason : ""}`);
  assert(
    res.quality.blurScore > wholeFrame,
    "the reported blur score must be the card's, not the frame's",
  );
  // And the ROI really is the card region rather than the whole image.
  const roi = markersRoi(res.markers)!;
  assert(roi.x1 - roi.x0 < W / 2 && roi.y1 - roi.y0 < H / 2);
});

// ── The resolution ladder gets more pixels each rung ─────────────────

Deno.test("toGray leaves the caller's Image alone", () => {
  // ImageScript's resize MUTATES. When toGray used it, rung one of the ladder
  // permanently shrank the photo, so rung two re-scaled an already-small image
  // UP — the escalation added no detail, and its `scale` came back 1.0 against
  // the shrunken image, leaving the homography in the wrong pixel space.
  const img = new Image(1200, 900);
  for (let y = 1; y <= 900; y++) {
    for (let x = 1; x <= 1200; x++) img.setPixelAt(x, y, 0x808080ff);
  }
  const a = toGray(img, 600);
  assertEquals([img.width, img.height], [1200, 900]);
  assertEquals([a.gray.width, a.gray.height], [600, 450]);
  assertAlmostEquals(a.scale, 0.5, 1e-9);

  const b = toGray(img, 1200);
  assertEquals([b.gray.width, b.gray.height], [1200, 900]);
  assertAlmostEquals(b.scale, 1, 1e-9);
});

Deno.test("each ladder rung really resolves the card better than the last", () => {
  const rungs = detectRungs(4000);
  assert(rungs.length > 1, "a 4000px photo has more than one rung to climb");

  const card = renderCard({ ppi: 110 / CARD.markerSizeInches, padIn: 0.3 });
  const img = new Image(4000, 3000);
  for (let y = 1; y <= 3000; y++) {
    for (let x = 1; x <= 4000; x++) img.setPixelAt(x, y, 0x969696ff);
  }
  for (let y = 0; y < card.height; y++) {
    for (let x = 0; x < card.width; x++) {
      const v = card.gray[y * card.width + x];
      img.setPixelAt(200 + x + 1, 1900 + y + 1, ((v << 24) | (v << 16) | (v << 8) | 0xff) >>> 0);
    }
  }

  let prevSide = 0;
  for (const dim of rungs) {
    const { gray, scale } = toGray(img, dim);
    assertEquals(gray.width, Math.round(4000 * scale));
    const res = calibrateMeasurePhoto(gray, MEASURE_CARD_VERSIONS);
    assert(res.ok, `rung ${dim}: ${!res.ok ? res.reason : ""}`);
    assert(
      res.quality.minMarkerSidePx > prevSide,
      `rung ${dim} resolved the marker at ${res.quality.minMarkerSidePx.toFixed(1)}px, no better than the previous rung's ${prevSide.toFixed(1)}px`,
    );
    prevSide = res.quality.minMarkerSidePx;
  }
});
