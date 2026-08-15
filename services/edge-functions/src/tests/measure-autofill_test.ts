// US-2595: the MeasureCard autofill — the two defects it fixes, pinned.
//
//   deno test --allow-env --allow-read src/tests/measure-autofill_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { MEASURE_ITEM_COLUMNS, measurableKeys, needsMeasuring } = await import(
  "../lib/measure-autofill.ts"
);
const { measurementGroupForItem, garmentDescriptorFor } = await import(
  "../lib/measurement-templates.ts"
);

// ── Defect 1: the column that does not exist ────────────────────────
//
// `category` is a COALESCE alias on the items_full VIEW, not a column on
// inventory_items. Selecting it through PostgREST answers 42703 with a null
// `data`, and the route read that as "Item not found" — so /measure/extract
// 404'd for every seller on every client, and nobody could tell the difference
// between "auto-measure is broken" and "my card photo is bad".

Deno.test("US-2595: the item load selects real inventory_items columns", () => {
  const cols = MEASURE_ITEM_COLUMNS.split(",").map((c) => c.trim());
  assert(!cols.includes("category"), "`category` is a view alias, not a column");
  for (const needed of ["garment_category", "garment_type", "item_category"]) {
    assert(cols.includes(needed), `${needed} must be selected`);
  }
});

Deno.test("US-2595: no edge query selects a bare `category` off inventory_items", async () => {
  // The class of bug, not just the instance. A `.select(...)` naming `category`
  // within a few lines of `.from("inventory_items")` is the shape that failed.
  const roots = ["../lib", "../routes"];
  const offenders: string[] = [];
  for (const root of roots) {
    const dir = new URL(`${root}/`, import.meta.url);
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      const src = await Deno.readTextFile(new URL(entry.name, dir));
      const re = /\.from\("inventory_items"\)[\s\S]{0,240}?\.select\(\s*("[^"]*"|[A-Z_]+)/g;
      for (const m of src.matchAll(re)) {
        const cols = m[1];
        if (!cols.startsWith('"')) continue; // a shared constant — pinned above
        const named = cols.slice(1, -1).split(",").map((c) => c.trim());
        if (named.includes("category")) offenders.push(`${entry.name}: ${cols}`);
      }
    }
  }
  assertEquals(offenders, []);
});

// ── Defect 2: "clothing" is not a garment ───────────────────────────

Deno.test("US-2595: the group comes from the garment, not the vertical", () => {
  // A blazer whose vertical was set — the exact row shape that produced a
  // generic length+width template and no chest, shoulder or sleeve.
  assertEquals(
    measurementGroupForItem({
      item_category: "clothing",
      garment_category: "jacket",
      garment_type: "outerwear",
      category: "clothing",
    }),
    "outerwear",
  );
  // Shorts: waist + inseam, not length + width.
  assertEquals(
    measurementGroupForItem({
      item_category: "clothing",
      garment_category: "shorts",
      category: "clothing",
    }),
    "bottom",
  );
  // The coarse garment_type alone still resolves.
  assertEquals(
    measurementGroupForItem({ item_category: "clothing", garment_type: "bottoms" }),
    "bottom",
  );
  // Last resort: the title carries the noun when nothing else does.
  assertEquals(
    measurementGroupForItem({
      item_category: "clothing",
      title: "Vintage Levi's 550 Denim Shorts",
    }),
    "bottom",
  );
  // Nothing to go on stays generic rather than guessing.
  assertEquals(measurementGroupForItem({ item_category: "clothing" }), "generic");
});

Deno.test("US-2595: a non-clothing vertical still resolves from its own column", () => {
  assertEquals(measurementGroupForItem({ item_category: "shoes" }), "shoes");
  assertEquals(measurementGroupForItem({ item_category: "watches" }), "watch");
  assertEquals(garmentDescriptorFor({ item_category: "shoes" }), "shoes");
});

// ── The skip conditions (spend discipline) ──────────────────────────

Deno.test("needsMeasuring: a fully measured item never triggers a vision call", () => {
  const full: Record<string, unknown> = {};
  for (const key of measurableKeys("bottom")) full[key] = 20;
  assertEquals(needsMeasuring("bottom", full), false);
  delete full.inseam;
  assertEquals(needsMeasuring("bottom", full), true);
  assertEquals(needsMeasuring("bottom", null), true);
});

Deno.test("needsMeasuring: a blank string counts as unmeasured", () => {
  const partial: Record<string, unknown> = {};
  for (const key of measurableKeys("top")) partial[key] = 20;
  partial.sleeve = "   ";
  assertEquals(needsMeasuring("top", partial), true);
});

Deno.test("measurableKeys: only length-unit fields are photo-measurable", () => {
  // Shoes are sold on a US size, which is not something a tape reaches.
  assertEquals(measurableKeys("shoes"), ["insole"]);
  // A watch is all millimetres — nothing for this pass to do.
  assertEquals(measurableKeys("watch"), []);
  assertEquals(measurableKeys("bottom"), [
    "waist",
    "inseam",
    "rise",
    "hip",
    "leg_opening",
  ]);
});

// ── The card is FOUND, not tagged ───────────────────────────────────
//
// This is the defect that made every other fix invisible: ai-photo-roles can
// only assign front|back|tag|detail|defect, so a bulk-uploaded set never
// contains a photo of type 'measurement'. Every measure surface filtered on
// exactly that, so the card sat in the set and nothing looked at it.

Deno.test("US-2595: the photo-role classifier still cannot emit 'measurement'", async () => {
  // If this ever changes, the scan below becomes a fallback rather than the
  // primary path — worth knowing, and worth failing to find out.
  const { PHOTO_ROLES } = await import("../lib/ai-photo-roles.ts");
  assert(
    !(PHOTO_ROLES as readonly string[]).includes("measurement"),
    "the scan exists because the classifier has no 'measurement' role",
  );
});

Deno.test("US-2595: the autofill scans photos for the card instead of trusting a tag", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/measure-autofill.ts", import.meta.url),
  );
  // It must not narrow the query to already-tagged photos — that is the bug.
  assert(
    !src.includes('.eq("photo_type", "measurement")'),
    "narrowing to photo_type='measurement' is what made the card invisible",
  );
  assert(src.includes("calibrateMeasurePhoto("), "detection is the finder");
  // Finding it must retag, or the composer editor and the publish path (both
  // of which DO filter on photo_type) still can't see it.
  assert(src.includes('patch.photo_type = "measurement"'));
  // Bounded: a set of 40 photos must not open all 40.
  assert(src.includes("MAX_CARD_SCAN"));
});

Deno.test("US-2595: the scan never opens a private or derived photo", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/measure-autofill.ts", import.meta.url),
  );
  // 'internal' and 'certificate' are seller-private (US-1549) and
  // measurement_overlay is the render we made FROM a card — none can BE one.
  for (const t of ["measurement_overlay", "internal", "certificate"]) {
    assert(src.includes(`"${t}"`), `${t} must be excluded from the scan`);
  }
});

Deno.test("US-2595: the card must be found before the listing photos load", async () => {
  // Retagging removes the branded card from the listing gallery. Load the
  // photos first and the card ships to eBay in the buyer's photo set.
  const src = await Deno.readTextFile(
    new URL("../lib/ai-listing.ts", import.meta.url),
  );
  const measure = src.indexOf("autofillMeasurementsFromCard(");
  const load = src.indexOf("const photos = await loadItemPhotoUrls(itemId)");
  assert(measure > 0 && load > 0);
  assert(
    measure < load,
    "the measure pass must run before loadItemPhotoUrls, not after",
  );
});

// ── The pass has to say what it did ─────────────────────────────────

Deno.test("US-2596: every outcome is recorded on the item", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/measure-autofill.ts", import.meta.url),
  );
  // The record must wrap the WHOLE pass, not sit inside the success branch —
  // the outcomes worth explaining are the ones where nothing happened.
  assert(src.includes("MEASURE_PASS_KEY"));
  assert(
    src.includes("const result = await runAutofill("),
    "the recorder must wrap runAutofill so no-op outcomes are recorded too",
  );
  assert(src.includes("ranAt:"));
});

Deno.test("US-2596: the outcome key cannot be mistaken for a field provenance entry", async () => {
  const { MEASURE_PASS_KEY } = await import("../lib/measure-autofill.ts");
  const { hasCalibratedMeasurements } = await import("../lib/measurements.ts");
  assertEquals(MEASURE_PASS_KEY, "measurements._pass");
  // hasCalibratedMeasurements walks every `measurements.` key. A pass record
  // must not read as "this item was measured with a calibration card", or a
  // failed pass would earn the listing a method note it did not deserve.
  assertEquals(
    hasCalibratedMeasurements({
      [MEASURE_PASS_KEY]: {
        reason: "no_measurement_photo",
        ranAt: new Date(0).toISOString(),
      },
    }),
    false,
  );
  // A real measured field still counts.
  assertEquals(
    hasCalibratedMeasurements({
      "measurements.waist": { source: "ai_measured", measuredAt: "2026-01-01T00:00:00Z" },
    }),
    true,
  );
});

// ── The generation wiring ───────────────────────────────────────────

Deno.test("US-2595: listing generation runs the measure and size passes itself", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/ai-listing.ts", import.meta.url),
  );
  assert(
    src.includes("autofillMeasurementsFromCard("),
    "generateListing must fill measurements from the card",
  );
  assert(
    src.includes("estimateSize({"),
    "generateListing must estimate a missing size",
  );
  // Both are bundled into the one generation action, so their spend has to
  // reach the usage log — otherwise per-item billing understates Anthropic.
  assert(src.includes("measureCost") && src.includes("sizeCost"));
  assert(src.includes("+ measureCost + sizeCost"));
});
