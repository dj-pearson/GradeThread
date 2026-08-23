// US-827: measurements → eBay aspects, unit formatting, and the idempotent
// description block. Pure functions — no Anthropic/Supabase/env.
//   deno test src/tests/measurements_test.ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyMeasurementsBlock,
  buildMeasurementLines,
  buildPlainMeasurementsText,
  CALIBRATED_MEASURE_NOTE,
  hasCalibratedMeasurements,
  buildMeasurementsBlock,
  formatMeasurementValue,
  MEASUREMENTS_BLOCK_END,
  MEASUREMENTS_BLOCK_START,
  forceMeasurementAspects,
  resolveMeasurementAspects,
} from "../lib/measurements.ts";

// ── Unit formatting (US-648) ────────────────────────────────────────────────

Deno.test("format: length renders inches by default, trimming whole numbers", () => {
  assertEquals(formatMeasurementValue("chest", 21), "21 in");
  assertEquals(formatMeasurementValue("inseam", 32.5), "32.5 in");
});

Deno.test("format: length converts inches → cm when unit is cm", () => {
  assertEquals(formatMeasurementValue("chest", 20, "cm"), "50.8 cm");
  assertEquals(formatMeasurementValue("length", 10, "cm"), "25.4 cm");
});

Deno.test("format: shoe sizes render 'US N' and never convert", () => {
  assertEquals(formatMeasurementValue("size_us", 10.5, "cm"), "US 10.5");
});

Deno.test("format: watch dimensions render mm and never convert", () => {
  assertEquals(formatMeasurementValue("case_diameter", 42, "cm"), "42 mm");
});

Deno.test("format: non-positive / invalid values return null (no zero-width lies)", () => {
  assertEquals(formatMeasurementValue("chest", 0), null);
  assertEquals(formatMeasurementValue("chest", -3), null);
  assertEquals(formatMeasurementValue("chest", "abc"), null);
  assertEquals(formatMeasurementValue("chest", null), null);
});

Deno.test("format: numeric strings coerce", () => {
  assertEquals(formatMeasurementValue("waist", "30"), "30 in");
});

// ── Aspect mapping (US-822 registry style) ──────────────────────────────────

Deno.test("aspects: fills free-text measurement aspects that exist in the category", () => {
  const out = resolveMeasurementAspects(
    { chest: 21, inseam: 32, sleeve: 25 },
    { "Chest Size": [], "Inseam": [], "Brand": [] },
  );
  // US-2630: chest is measured pit to pit on a folded garment, so the WORN
  // chest is 42in. The inseam is a single span and is published as measured.
  assertEquals(out, { "Chest Size": ["42 in"], "Inseam": ["32 in"] });
  // sleeve omitted: no matching aspect name in this category's spec.
});

Deno.test("aspects: never fills a SELECTION_ONLY aspect (has allowed values)", () => {
  const out = resolveMeasurementAspects(
    { sleeve: 25 },
    { "Sleeve Length": ["Short Sleeve", "Long Sleeve"] }, // style dropdown
  );
  assertEquals(out, {});
});

Deno.test("aspects: never overwrites an already-set aspect", () => {
  const out = resolveMeasurementAspects(
    { waist: 30 },
    { "Waist Size": [] },
    { "Waist Size": ["32"] },
  );
  assertEquals(out, {});
});

Deno.test("aspects: matches candidate names case-insensitively + respects cm unit", () => {
  const out = resolveMeasurementAspects(
    { chest: 20 },
    { "chest size": [] },
    {},
    "cm",
  );
  // US-2630: 20in flat = a 40in chest = 101.6cm.
  assertEquals(out, { "chest size": ["101.6 cm"] });
});

// A men's hoodie exposes "Sleeve Length" as FREE_TEXT holding "Long Sleeve".
// The measurements projection must not treat that as its own stale mirror —
// clearing or overwriting it silently loses a real item specific. Kept in
// lockstep with src/lib/__tests__/measurements.test.ts (web mirror).
Deno.test("force: never clears a categorical value in a measurement-named aspect", () => {
  const out = forceMeasurementAspects(
    {},
    { "Sleeve Length": [] },
    { "Sleeve Length": ["Long Sleeve"] },
    "in",
    { "Sleeve Length": "inventory_derived" },
  );
  assertEquals(out, { aspects: {}, cleared: [] });
});

Deno.test("force: never overwrites a categorical value with a measurement", () => {
  const out = forceMeasurementAspects(
    { sleeve: 25 },
    { "Sleeve Length": [] },
    { "Sleeve Length": ["Long Sleeve"] },
  );
  assertEquals(out, { aspects: {}, cleared: [] });
});

Deno.test("force: still fills / clears a genuinely measurement-shaped aspect", () => {
  assertEquals(
    forceMeasurementAspects({ sleeve: 25 }, { "Sleeve Length": [] }, {}),
    { aspects: { "Sleeve Length": ["25 in"] }, cleared: [] },
  );
  assertEquals(
    forceMeasurementAspects(
      {},
      { Inseam: [] },
      { Inseam: ["32 in"] },
      "in",
      { Inseam: "inventory_derived" },
    ),
    { aspects: {}, cleared: ["Inseam"] },
  );
});

// ── Description block ────────────────────────────────────────────────────────

Deno.test("block: lines render in canonical key order with labels", () => {
  const lines = buildMeasurementLines({ inseam: 32, chest: 21 });
  // chest is defined before inseam in MEASUREMENT_SPECS → comes first.
  // US-2630: the chest line carries BOTH numbers — the worn chest a buyer
  // shops by, and the flat number they can check with their own tape. The
  // inseam is a single span, so there is only one number to give.
  assertEquals(lines, [
    "- Chest (pit to pit): 42 in (21 in flat)",
    "- Inseam: 32 in",
  ]);
});

Deno.test("block: empty / missing measurements produce no block", () => {
  assertEquals(buildMeasurementsBlock({}), "");
  assertEquals(buildMeasurementsBlock(null), "");
  assertEquals(buildMeasurementsBlock({ chest: 0 }), "");
});

Deno.test("apply: appends a marker-delimited block to a description", () => {
  const out = applyMeasurementsBlock("Great hoodie.", { chest: 21 });
  assertStringIncludes(out, "Great hoodie.");
  assertStringIncludes(out, MEASUREMENTS_BLOCK_START);
  assertStringIncludes(out, "- Chest (pit to pit): 42 in (21 in flat)");
  assertStringIncludes(out, MEASUREMENTS_BLOCK_END);
});

Deno.test("apply: is IDEMPOTENT — re-applying never duplicates the block", () => {
  const once = applyMeasurementsBlock("Great hoodie.", { chest: 21 });
  const twice = applyMeasurementsBlock(once, { chest: 21 });
  assertEquals(once, twice);
  // exactly one start marker.
  assertEquals(twice.split(MEASUREMENTS_BLOCK_START).length - 1, 1);
});

Deno.test("apply: refreshes the block on re-save with changed measurements", () => {
  const first = applyMeasurementsBlock("Tee.", { chest: 20 });
  const updated = applyMeasurementsBlock(first, { chest: 22, length: 28 });
  assertStringIncludes(updated, "- Chest (pit to pit): 44 in (22 in flat)");
  assertStringIncludes(updated, "- Length: 28 in");
  // The old 20in flat / 40in worn pair is gone, not merely appended past.
  assertEquals(updated.includes("20 in"), false);
  assertEquals(updated.includes("40 in"), false);
  assertEquals(updated.split(MEASUREMENTS_BLOCK_START).length - 1, 1);
});

Deno.test("apply: removes the block when measurements are cleared", () => {
  const withBlock = applyMeasurementsBlock("Tee.", { chest: 20 });
  const cleared = applyMeasurementsBlock(withBlock, {});
  assertEquals(cleared, "Tee.");
});

Deno.test("apply: honors the cm preference in the rendered block", () => {
  const out = applyMeasurementsBlock("Pants.", { inseam: 30 }, "cm");
  assertStringIncludes(out, "- Inseam: 76.2 cm");
});

// ── US-1578: measurements ride every listing surface ────────────────

Deno.test("US-1578: calibrated note rides the block (and re-apply upgrades in place)", () => {
  const meas = { chest: 22, length: 28.5 };
  const plainBlock = applyMeasurementsBlock("Desc.", meas);
  assert(!plainBlock.includes(CALIBRATED_MEASURE_NOTE));
  const noted = applyMeasurementsBlock(plainBlock, meas, "in", { calibrated: true });
  assert(noted.includes(CALIBRATED_MEASURE_NOTE));
  // Idempotent upgrade: exactly one block, one note.
  assertEquals(noted.match(/gradethread-measurements/g)?.length, 2); // start+end
  assertEquals(noted.split(CALIBRATED_MEASURE_NOTE).length - 1, 1);
  // Note text is link-free (the eBay no-off-site rule).
  assert(!/https?:|gradethread\.com/i.test(CALIBRATED_MEASURE_NOTE));
});

Deno.test("US-1578: hasCalibratedMeasurements keys off measurements.* + measuredAt", () => {
  assert(
    hasCalibratedMeasurements({
      "measurements.chest": { source: "ai_measured", measuredAt: "2026-07-03T00:00:00Z" },
    }),
  );
  assert(
    hasCalibratedMeasurements({
      "measurements.waist": { source: "manual", measuredAt: "2026-07-03T00:00:00Z" },
    }),
    "editor-manual saves count — they came from the calibrated photo too",
  );
  assert(!hasCalibratedMeasurements({ "measurements.chest": { source: "ai" } }));
  assert(!hasCalibratedMeasurements({ brand: { source: "ai" } }));
  assert(!hasCalibratedMeasurements(null));
});

Deno.test("US-1578: plain-text section for cross-listing variants (no HTML markers)", () => {
  const text = buildPlainMeasurementsText({ chest: 22 }, "in", { calibrated: true });
  assert(text.startsWith("Measurements (garment laid flat):"));
  assert(text.includes("22"));
  assert(text.includes(CALIBRATED_MEASURE_NOTE));
  assert(!text.includes("<!--"), "plain text must carry no HTML comment markers");
  assertEquals(buildPlainMeasurementsText({}), "");
});

Deno.test("US-1578: variants + generation + revise all consume the store (source guard)", async () => {
  const aiListing = await Deno.readTextFile(
    new URL("../lib/ai-listing.ts", import.meta.url),
  );
  // Generation passes the calibrated flag.
  assert(aiListing.includes("calibrated: calibratedMeasurements"));
  // Variants append the plain block within each platform's cap.
  assert(aiListing.includes("buildPlainMeasurementsText(item.measurements"));
  assert(aiListing.includes('v.description.includes("Measurements (garment laid flat)")'));
  const ebay = await Deno.readTextFile(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  // Revise path re-applies with provenance.
  assert(ebay.includes("hasCalibratedMeasurements"));
});

// ── US-2630: flat across is HALF the way round ──────────────────────
//
// The card measures a garment lying flat, so the tape crosses ONE layer. An
// 11in flat waist is a 22in waist. `waist` fed eBay's "Waist Size" aspect
// verbatim, so a 32in pair of jeans published as a 16 — not a rounding
// difference, but the wrong garment in every size filter a buyer uses.

const { CIRCUMFERENCE_KEYS, isCircumferenceMeasurement, listingMeasurementValue } =
  await import("../lib/measurements.ts");

Deno.test("US-2630: only folded-flat measurements double", () => {
  // Fabric folded flat: across x 2 is the way round.
  for (const key of ["chest", "bust", "waist", "hip", "leg_opening"]) {
    assert(isCircumferenceMeasurement(key), `${key} is a circumference`);
    assertEquals(listingMeasurementValue(key, 11), 22);
  }
  // Single spans. Doubling an inseam invents a garment nobody owns.
  for (const key of ["inseam", "rise", "length", "sleeve", "shoulder", "insole"]) {
    assert(!isCircumferenceMeasurement(key), `${key} is a single span`);
    assertEquals(listingMeasurementValue(key, 30), 30);
  }
});

Deno.test("US-2630: a hat is measured round, not folded", () => {
  // Deliberately absent. A hat's opening laid flat gives a DIAMETER, and a
  // circle's circumference is pi x d — doubling would be wrong by ~57%. The
  // headwear template asks for the true circumference instead.
  assert(!CIRCUMFERENCE_KEYS.has("circumference"));
  assertEquals(listingMeasurementValue("circumference", 23), 23);
});

Deno.test("US-2630: the seller's own waist reading reaches eBay doubled", () => {
  // The reported case, end to end: 11in flat waist, 13in flat hip.
  const out = resolveMeasurementAspects(
    { waist: 11, hip: 13, inseam: 30 },
    { "Waist Size": [], "Hip Size": [], "Inseam": [] },
  );
  assertEquals(out, {
    "Waist Size": ["22 in"],
    "Hip Size": ["26 in"],
    "Inseam": ["30 in"],
  });
});

Deno.test("US-2630: a blank measurement still yields nothing", () => {
  assertEquals(listingMeasurementValue("waist", null), null);
  assertEquals(listingMeasurementValue("waist", 0), null);
  assertEquals(listingMeasurementValue("waist", "not a number"), null);
});

// ── US-2796 AC3: a non-US number must never fill a US-named aspect ─────────
//
// size_us holds whatever number is stamped on the shoe, and US-2796 added the
// SCALE it is on. Its candidates are ["US Shoe Size", "Shoe Size"], so before
// this a Dr. Martens UK 9 filled "US Shoe Size" with 9 - and a UK 9 is around a
// US men's 9.5-10. That is a full size wrong on the one field a shoe listing is
// searched by.
//
// The fix DROPS the US-named candidate rather than converting the number.
// Converting is the trap: "US Shoe Size" means the US size in THIS category's
// department, and eBay splits shoe categories by department, so a women's 9 is
// already correct under a women's category and converting it to a men's 7.5
// would introduce the error. Only uk/eu/jp are unambiguously wrong.

const SHOE_SPEC_BOTH = { "US Shoe Size": [], "Shoe Size": [] };
const SHOE_SPEC_US_ONLY = { "US Shoe Size": [] };

Deno.test("US-2796 AC3: a UK size falls through to the scale-neutral aspect", () => {
  const out = resolveMeasurementAspects(
    { size_us: 9 },
    SHOE_SPEC_BOTH,
    {},
    "in",
    "uk",
  );
  assertEquals(out["US Shoe Size"], undefined, "a UK 9 must not publish as a US 9");
  assertEquals(out["Shoe Size"], ["US 9"]);
});

Deno.test("US-2796 AC3: with only a US-named aspect, a UK size fills nothing", () => {
  // Blank is a question eBay's required-aspect gap-fill puts to the seller.
  // A wrong number is an answer nobody asked for.
  const out = resolveMeasurementAspects(
    { size_us: 9 },
    SHOE_SPEC_US_ONLY,
    {},
    "in",
    "eu",
  );
  assertEquals(out, {});
});

Deno.test("US-2796 AC3: US scales are untouched, including us_women", () => {
  // us_women is CORRECT under a women's category, which is why it is not
  // converted. Treating it as non-US would empty an aspect that was right.
  for (const scale of ["us_men", "us_women"] as const) {
    const out = resolveMeasurementAspects({ size_us: 9 }, SHOE_SPEC_BOTH, {}, "in", scale);
    assertEquals(out["US Shoe Size"], ["US 9"], scale);
  }
});

Deno.test("US-2796 AC4: passing no scale is identical to the old four-argument call", () => {
  // The compatibility promise, asserted against the call every existing caller
  // makes rather than against a remembered value.
  const legacy = resolveMeasurementAspects({ size_us: 9 }, SHOE_SPEC_BOTH, {}, "in");
  for (const scale of [undefined, null] as const) {
    assertEquals(
      resolveMeasurementAspects({ size_us: 9 }, SHOE_SPEC_BOTH, {}, "in", scale),
      legacy,
      String(scale),
    );
  }
  assertEquals(legacy["US Shoe Size"], ["US 9"]);
});

Deno.test("US-2796 AC3: the scale does not touch a non-shoe measurement", () => {
  // The rule is keyed on spec.kind === "shoe". A garment measurement passing
  // through the same loop must be unaffected whatever the scale says.
  const out = resolveMeasurementAspects(
    { chest: 21 },
    { "Chest Size": [] },
    {},
    "in",
    "uk",
  );
  assertEquals(out["Chest Size"], ["42 in"]);
});

Deno.test("US-2796 AC3: Bust survives a non-US scale, which is what the two guards protect", () => {
  // NEITHER GUARD IN usableCandidates FIRES ON ITS OWN TODAY - sabotage measured
  // that and the source says so. Removing the spec.kind check alone changes
  // nothing, because no non-shoe aspect name holds "us" as a WORD. Removing the
  // word boundary alone changes nothing, because no shoe candidate holds "us" as
  // a mere substring.
  //
  // This is the case where the PAIR matters. "Bust" and "Bust Size" contain
  // "us", so a version with neither guard strips a bust measurement off any
  // listing whose shoe scale happens to be UK - a garment field deleted by a
  // footwear rule.
  const out = resolveMeasurementAspects(
    { bust: 20 },
    { "Bust": [], "Bust Size": [] },
    {},
    "in",
    "uk",
  );
  assertEquals(out["Bust"], ["40 in"], "a bust measurement was filtered by a shoe rule");
});
