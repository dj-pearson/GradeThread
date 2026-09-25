// MC-12: "Test my card". The detector is exercised against the committed
// MeasureCard fixtures; nothing here needs a database.
//
//   deno test --allow-env --allow-read --allow-ffi src/tests/flipdesk-measure-card-test_test.ts
//
// Under the npm imagescript substitute (CLAUDE.md), --allow-ffi is required
// for decode. None of these cases rotate an image, which that build gets wrong.

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

const { runCardTest, CARD_TEST_SCALE_NOTE } = await import(
  "../routes/flipdesk-measure.ts"
);
const {
  markerCorner,
  missingMarkerCorners,
  cardLayoutErrorFraction,
  estimateTiltDeg,
  CARD_TEST_LAYOUT_TOLERANCE,
} = await import("../lib/measure-detect.ts");
const { MEASURE_CARD_V1 } = await import("../lib/measure-card.ts");

const DIR = new URL("./fixtures/measure-card/", import.meta.url);
const ROUTE = await Deno.readTextFile(
  new URL("../routes/flipdesk-measure.ts", import.meta.url),
);

async function fixture(name: string): Promise<Image> {
  return (await Image.decode(await Deno.readFile(new URL(name, DIR)))) as Image;
}

Deno.test("MC-12: the straight-on fixture passes with all four markers", async () => {
  const r = runCardTest(await fixture("straight-on.png"));
  assertEquals(r.ok, true);
  assertEquals(r.markers_found, 4);
  assertEquals(r.missing_corners, []);
  assertEquals(r.card_version, 1);
  assert(r.residual_in !== null && r.residual_in < 0.06, `residual ${r.residual_in}`);
  assert(r.tilt_deg !== null && r.tilt_deg < 5, `tilt ${r.tilt_deg}`);
  assert(r.layout_error_pct !== null && r.layout_error_pct < 0.5);
  assertEquals(r.warning, undefined);
  // It never claims to have checked print scale.
  assertEquals(r.scale_checked, false);
  assertEquals(r.scale_note, CARD_TEST_SCALE_NOTE);
});

Deno.test("MC-12: a covered bottom-left square fails and is named", async () => {
  const r = runCardTest(await fixture("occluded-marker.png"));
  assertEquals(r.ok, false);
  assertEquals(r.markers_found, 3);
  assertEquals(r.missing_corner, "bottom-left");
  assertEquals(r.reason, "card_not_fully_visible");
  assert(r.message?.includes("bottom-left"), r.message);
});

Deno.test("MC-12: a corner painted out of the straight-on shot is named", async () => {
  const img = await fixture("straight-on.png");
  // Marker 11 (top-right) spans roughly x 808..917, y 128..237 in this fixture.
  for (let y = 110; y < 260; y++) {
    for (let x = 790; x < 940; x++) img.setPixelAt(x + 1, y + 1, 0xffffffff);
  }
  const r = runCardTest(img);
  assertEquals(r.ok, false);
  assertEquals(r.missing_corner, "top-right");
});

Deno.test("MC-12: a tilted shot still passes and reports a larger tilt", async () => {
  const flat = runCardTest(await fixture("straight-on.png"));
  const tilted = runCardTest(await fixture("tilt-30.png"));
  assertEquals(tilted.ok, true);
  assert(tilted.tilt_deg! > flat.tilt_deg!, `${tilted.tilt_deg} vs ${flat.tilt_deg}`);
});

Deno.test("MC-12: markerCorner and missingMarkerCorners name corners by position", () => {
  assertEquals(markerCorner(MEASURE_CARD_V1, 10), "top-left");
  assertEquals(markerCorner(MEASURE_CARD_V1, 11), "top-right");
  assertEquals(markerCorner(MEASURE_CARD_V1, 12), "bottom-right");
  assertEquals(markerCorner(MEASURE_CARD_V1, 13), "bottom-left");
  assertEquals(missingMarkerCorners([10, 11, 12], [MEASURE_CARD_V1]), {
    cardVersion: 1,
    missing: ["bottom-left"],
  });
  assertEquals(missingMarkerCorners([], [MEASURE_CARD_V1]), {
    cardVersion: null,
    missing: [],
  });
});

Deno.test("MC-12: layout error is measured against the 6x4in rectangle", () => {
  // An identity-like homography at 100 px per inch, and markers exactly where
  // the card says, then one of them 0.06in (1% of 6in) off in x.
  const H = [0.01, 0, 0, 0, 0.01, 0, 0, 0, 1];
  const at = (id: number, dx = 0) => {
    const [x, y] = MEASURE_CARD_V1.markerCentersInches[String(id)]!;
    return {
      id,
      corners: [] as Array<[number, number]>,
      center: [(x + dx) * 100, y * 100] as [number, number],
      sidePx: 100,
    };
  };
  const exact = [at(10), at(11), at(12), at(13)];
  assert(cardLayoutErrorFraction(H, exact, MEASURE_CARD_V1) < 1e-9);
  const off = [at(10), at(11, 0.06), at(12), at(13)];
  const e = cardLayoutErrorFraction(H, off, MEASURE_CARD_V1);
  assert(Math.abs(e - 0.01) < 1e-9, String(e));
  assert(e > CARD_TEST_LAYOUT_TOLERANCE);
  assertEquals(estimateTiltDeg(exact, MEASURE_CARD_V1), 0);
  assertEquals(estimateTiltDeg(exact.slice(0, 3), MEASURE_CARD_V1), null);
});

Deno.test("MC-12: the route validates the upload and stores nothing", () => {
  const at = ROUTE.indexOf('flipdeskMeasureRoutes.post("/card-test"');
  assert(at > -1, "POST /card-test is missing");
  const body = ROUTE.slice(at, ROUTE.indexOf("\n});", at));
  assert(body.includes("validateImageUpload(bytes"));
  assert(body.indexOf("validateImageUpload(") < body.indexOf("Image.decode("));
  for (const forbidden of ["supabaseAdmin", ".upload(", "withAiAction", "storage"]) {
    assert(!body.includes(forbidden), `card-test must not touch ${forbidden}`);
  }
});
