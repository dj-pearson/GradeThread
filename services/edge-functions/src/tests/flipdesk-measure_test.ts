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
