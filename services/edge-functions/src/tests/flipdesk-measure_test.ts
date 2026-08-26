// US-1572: calibration route unit tests — the pure helpers (grayscale +
// downscale-rescale math) and the tenant/source contracts that don't need a
// DB. The detector itself is covered against OpenCV ground truth in
// measure-detect_test.ts.
//
//   deno test --allow-env --allow-read src/tests/flipdesk-measure_test.ts

import { assert, assertEquals } from "@std/assert";
import { Image } from "imagescript";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { toGray, rescaleCalibration, MAX_DETECT_DIM } = await import(
  "../routes/flipdesk-measure.ts"
);
const { applyHomography } = await import("../lib/measure-detect.ts");

Deno.test("toGray: small images pass through at scale 1", () => {
  const img = new Image(100, 60);
  img.fill(0xffffffff);
  const { gray, scale } = toGray(img);
  assertEquals(scale, 1);
  assertEquals(gray.width, 100);
  assertEquals(gray.height, 60);
  assertEquals(gray.gray[0], 255);
});

Deno.test("toGray: oversized images downscale to MAX_DETECT_DIM", () => {
  const img = new Image(4000, 3000);
  img.fill(0x808080ff);
  const { gray, scale } = toGray(img);
  assertEquals(gray.width, MAX_DETECT_DIM);
  assertEquals(gray.height, 1500);
  assert(Math.abs(scale - 0.5) < 1e-9);
});

Deno.test("rescaleCalibration maps a downscaled homography back to original px", () => {
  // A pure-scale homography on the small image: 100 px/in.
  const small = {
    ok: true as const,
    cardVersion: 1,
    ppi: 100,
    homography: [1 / 100, 0, 0, 0, 1 / 100, 0, 0, 0, 1],
    markers: [{
      id: 10,
      corners: [[10, 10], [110, 10], [110, 110], [10, 110]] as Array<
        [number, number]
      >,
      center: [60, 60] as [number, number],
      sidePx: 100,
    }],
    quality: {
      markersFound: 4,
      minMarkerSidePx: 100,
      blurScore: 500,
      reprojResidualIn: 0.01,
    },
  };
  // Original was 2x the analyzed image (scale = 0.5).
  const orig = rescaleCalibration(small, 0.5);
  // A point at original px (240, 240) = small px (120, 120) = 1.2 inches.
  const [ix, iy] = applyHomography(orig.homography, 240, 240);
  assert(Math.abs(ix - 1.2) < 1e-9 && Math.abs(iy - 1.2) < 1e-9);
  assertEquals(orig.ppi, 200);
  assertEquals(orig.markers[0].center, [120, 120]);
  assertEquals(orig.markers[0].sidePx, 200);
});

// ── Source contracts ────────────────────────────────────────────────

const routeSrc = await Deno.readTextFile(
  new URL("../routes/flipdesk-measure.ts", import.meta.url),
);

Deno.test("US-268: the photo load is tenant-scoped through the item owner", () => {
  // The select must inner-join inventory_items and filter on the workspace
  // owner BEFORE any storage access — a foreign photo_id 404s.
  assert(routeSrc.includes("inventory_items!inner(user_id)"));
  assert(routeSrc.includes('.eq("inventory_items.user_id", ownerId)'));
  assert(
    routeSrc.includes('c.get("workspaceOwnerId") ?? c.get("userId")'),
    "workspace owner resolution must follow the US-268 pattern",
  );
});

Deno.test("photo bytes are read via downloadItemPhoto (dual-bucket helper)", () => {
  assert(routeSrc.includes("downloadItemPhoto("));
  assert(
    !routeSrc.includes('storage.from("item-photos").download'),
    "never download from a single hardcoded bucket",
  );
});

Deno.test("calibration is free; extraction is the billed AI action (US-1573)", () => {
  const calibrateStart = routeSrc.indexOf('post("/calibrate"');
  const extractStart = routeSrc.indexOf('post("/extract"');
  assert(calibrateStart >= 0 && extractStart > calibrateStart);
  const calibrateBlock = routeSrc.slice(calibrateStart, extractStart);
  const extractBlock = routeSrc.slice(extractStart);
  // /calibrate: pure CV — no model call, no reservation.
  assert(!calibrateBlock.includes("withAiAction"));
  assert(!calibrateBlock.includes("reserveAiAction"));
  assert(!calibrateBlock.includes("extractMeasurements"));
  // /extract: exactly the US-1581 contract — quota gate + atomic reserve
  // around the single vision call, 429 mapping included.
  assert(extractBlock.includes("checkQuota(ownerId)"));
  assert(extractBlock.includes("withAiAction(ownerId, quota.limit"));
  assert(extractBlock.includes("AiQuotaExhaustedError"));
});

// ── US-2627: a big garment makes the card small ──────────────────────
//
// The minimum-marker gate measured the card in the DOWNSCALED working image, so
// it was really asking "how much of the frame does the card fill" — a property
// of the garment, not the photograph. Pants laid flat put the card's 1in
// markers at ~40px once a 4032px photo is squeezed to 2000, which is exactly
// the limit, and the seller was told to "move the camera closer" — advice that
// cannot be followed, because moving closer crops the garment being measured.

const { calibrateAdaptive, detectRungs, shouldEscalate, DETECT_DIM_LADDER } =
  await import("../lib/measure-calibrate.ts");
const { MEASURE_CARD_VERSIONS } = await import("../lib/measure-card.ts");

const QUALITY = (markersFound: number) => ({
  markersFound,
  minMarkerSidePx: markersFound ? 12 : 0,
  blurScore: 500,
  reprojResidualIn: Infinity,
});
import type { CalibrateFailure, CalibrateResult } from "../lib/measure-detect.ts";
const failure = (reason: CalibrateFailure, markersFound: number): CalibrateResult =>
  ({ ok: false, reason, message: "", quality: QUALITY(markersFound) });

Deno.test("US-2627: rungs start cheap, climb, and never upscale", () => {
  assertEquals(DETECT_DIM_LADDER[0], MAX_DETECT_DIM);
  const big = detectRungs(6000);
  assertEquals(big, [...DETECT_DIM_LADDER]);
  assertEquals(big, [...big].sort((a, b) => a - b));
  // Clamped to the photo's own size...
  assertEquals(detectRungs(4032), [2000, 3000, 4032]);
  // ...and a photo smaller than the cheap rung runs exactly once.
  assertEquals(detectRungs(900), [900]);
  assertEquals(detectRungs(2000), [2000]);
});

Deno.test("US-2627: escalate only when more pixels could change the answer", () => {
  // The reported failure: markers seen, too small to decode. This is the case
  // that told sellers to move closer and crop the garment.
  assert(shouldEscalate(failure("markers_too_small", 4), true));
  // Part of the card resolved — evidence enough to spend another pass.
  assert(shouldEscalate(failure("card_not_fully_visible", 2), true));
  // Nothing resolution can fix.
  assert(!shouldEscalate(failure("photo_too_blurry", 0), false));
  assert(!shouldEscalate(failure("card_bent_or_angled", 4), false));
  // US-2672: except blur, when the card was actually seen. Downsampling to the
  // cheap rung is itself a low-pass filter, so a sharp card in a large-garment
  // frame can read soft at 2000px and sharp at 4032. With no markers at all the
  // softness belongs to the photo and the answer does not change.
  assert(shouldEscalate(failure("photo_too_blurry", 4), true));
  assert(!shouldEscalate(failure("photo_too_blurry", 0), true));
  // A success never climbs.
  assert(
    !shouldEscalate(
      { ok: true, cardVersion: 1, ppi: 100, homography: [], markers: [], quality: QUALITY(4) },
      false,
    ),
  );
});

Deno.test("US-2627: a scan does not pay to prove a garment shot is a garment shot", () => {
  // No marker anywhere, and nothing claims this photo is the card. The scan
  // opens up to a dozen photos per item; climbing on each would triple the cost
  // of every generation.
  assert(!shouldEscalate(failure("card_not_found", 0), true));
  // But when the seller TAGGED it as the card, "nothing at 2000px" is a
  // resolution problem, not an answer.
  assert(shouldEscalate(failure("card_not_found", 0), false));
});

Deno.test("US-2627: the returned gray belongs to the attempt that ran", () => {
  // extractMeasurements snaps endpoints in this gray's space using `scale`. A
  // gray from one rung paired with a scale from another would move every
  // endpoint by the ratio between them.
  const img = new Image(900, 600);
  img.fill(0xffffffff);
  const out = calibrateAdaptive(img, MEASURE_CARD_VERSIONS);
  assertEquals(out.attempted, [900]);
  assertEquals(out.scale, 1);
  assertEquals(out.gray.width, 900);
  assertEquals(out.gray.height, 600);
});

// ── US-2888: re-detecting the card must not delete the seller's lines ────────
//
// /calibrate?force writes a whole new StoredCalibration. It used to build that
// object from the detector's output alone, so `lines` -- the endpoint geometry
// the seller had dragged onto the garment -- was simply absent from the row
// afterwards. Nothing errored and nothing warned; the measurements panel just
// came back empty, from a button whose name is about the card.
const { withPreservedLines } = await import("../lib/measure-calibrate.ts");

const FRESH = {
  v: 1 as const,
  cardVersion: 1,
  ppi: 101,
  homography: [0.0101, 0, -0.5, 0, 0.0101, -0.6, 0, 0, 1],
  quality: {
    markersFound: 4,
    minMarkerSidePx: 60,
    blurScore: 120,
    reprojResidualIn: 0.01,
  },
  computedAt: "2026-08-25T00:00:00.000Z",
};

const LINES = {
  chest: {
    e1: [400, 900] as [number, number],
    e2: [2400, 900] as [number, number],
    inches: 20,
    label: "Chest (in)",
  },
};

Deno.test("a forced re-detect keeps the dragged lines", () => {
  const merged = withPreservedLines(FRESH, { ...FRESH, ppi: 99, lines: LINES });
  assertEquals(merged.lines, LINES);
  // The RULER is the thing that was re-read, so it must be the new one.
  assertEquals(merged.ppi, 101);
});

Deno.test("no stored lines leaves the fresh calibration exactly as detected", () => {
  assertEquals(withPreservedLines(FRESH, null), FRESH);
  assertEquals(withPreservedLines(FRESH, undefined), FRESH);
  assertEquals(withPreservedLines(FRESH, { ...FRESH, lines: {} }), FRESH);
});
