// US-1570: MeasureCard geometry constants must match the committed artwork's
// canonical JSON (assets/measure-card/geometry-v1.json) and the printed spec
// invariants — guarding against silent drift between the artwork, the spec
// doc, and the CV code that will consume these numbers.
//
//   deno test --allow-read src/tests/measure-card_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  cardVersionForIds,
  MEASURE_CARD_V1,
  MEASURE_CARD_VERSIONS,
} from "../lib/measure-card.ts";

const canonical = JSON.parse(
  await Deno.readTextFile(
    new URL("../../../../assets/measure-card/geometry-v1.json", import.meta.url),
  ),
);

Deno.test("constants match the committed artwork JSON exactly", () => {
  assertEquals(
    JSON.parse(JSON.stringify(MEASURE_CARD_V1)),
    canonical,
    "lib/measure-card.ts drifted from assets/measure-card/geometry-v1.json — regenerate the constants from the JSON",
  );
});

Deno.test("spec invariants: 6x4in center rectangle, >=1in markers, >=0.25in quiet zones", () => {
  const g = MEASURE_CARD_V1;
  assertEquals(g.centerRectInches, { w: 6, h: 4 });
  assert(g.markerSizeInches >= 1.0);
  assert(g.quietZoneInches >= 0.25);
  assertEquals(g.dictionary, "DICT_5X5_1000");
  assertEquals(g.markerIds, [10, 11, 12, 13]);
  // Centers must actually FORM the declared rectangle.
  const [tl, tr, br, bl] = g.markerIds.map((id) =>
    g.markerCentersInches[String(id)]
  );
  assertEquals(tr[0] - tl[0], g.centerRectInches.w);
  assertEquals(br[1] - tr[1], g.centerRectInches.h);
  assertEquals(br[0] - bl[0], g.centerRectInches.w);
  assertEquals(bl[1] - tl[1], g.centerRectInches.h);
  // Every marker (plus its quiet zone) must sit fully INSIDE the card — the
  // flaw the 300dpi detection validation originally caught (edge-flush
  // markers have no printed quiet zone and fail detection on dark surfaces).
  const pad = g.markerSizeInches / 2 + g.quietZoneInches;
  for (const id of g.markerIds) {
    const [cx, cy] = g.markerCentersInches[String(id)];
    assert(cx - pad >= 0 && cy - pad >= 0, `marker ${id} breaches quiet zone`);
    assert(
      cx + pad <= g.cardInches.w && cy + pad <= g.cardInches.h,
      `marker ${id} breaches quiet zone`,
    );
  }
});

Deno.test("marker bit matrices are 5x5, binary, and distinct per id", () => {
  const seen = new Set<string>();
  for (const id of MEASURE_CARD_V1.markerIds) {
    const bits = MEASURE_CARD_V1.markerBits[String(id)];
    assertEquals(bits.length, 5);
    for (const row of bits) {
      assertEquals(row.length, 5);
      for (const b of row) assert(b === 0 || b === 1);
    }
    const key = JSON.stringify(bits);
    assert(!seen.has(key), `duplicate bit pattern for id ${id}`);
    seen.add(key);
  }
});

Deno.test("cardVersionForIds identifies v1 and rejects partial/foreign id sets", () => {
  assertEquals(cardVersionForIds([13, 10, 12, 11])?.version, 1);
  assertEquals(cardVersionForIds([10, 11, 12]), null);
  assertEquals(cardVersionForIds([1, 2, 3, 4]), null);
  assert(MEASURE_CARD_VERSIONS.length >= 1);
});
