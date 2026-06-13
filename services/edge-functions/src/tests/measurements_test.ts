// US-827: measurements → eBay aspects, unit formatting, and the idempotent
// description block. Pure functions — no Anthropic/Supabase/env.
//   deno test src/tests/measurements_test.ts
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyMeasurementsBlock,
  buildMeasurementLines,
  buildMeasurementsBlock,
  formatMeasurementValue,
  MEASUREMENTS_BLOCK_END,
  MEASUREMENTS_BLOCK_START,
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
  assertEquals(out, { "Chest Size": ["21 in"], "Inseam": ["32 in"] });
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
  assertEquals(out, { "chest size": ["50.8 cm"] });
});

// ── Description block ────────────────────────────────────────────────────────

Deno.test("block: lines render in canonical key order with labels", () => {
  const lines = buildMeasurementLines({ inseam: 32, chest: 21 });
  // chest is defined before inseam in MEASUREMENT_SPECS → comes first.
  assertEquals(lines, ["- Chest (pit to pit): 21 in", "- Inseam: 32 in"]);
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
  assertStringIncludes(out, "- Chest (pit to pit): 21 in");
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
  assertStringIncludes(updated, "- Chest (pit to pit): 22 in");
  assertStringIncludes(updated, "- Length: 28 in");
  assertEquals(updated.includes("20 in"), false);
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
