// US-1088: pure-function tests for the Size AI helpers + sizing-chart knowledge
// layer (no network — the Anthropic call in estimateSize is not exercised here).

import { assert, assertEquals } from "@std/assert";
import {
  isMeasurementPhoto,
  normalizeSizeEstimate,
  prioritizeMeasurementPhotos,
} from "../lib/ai-size-estimate-core.ts";
import {
  findSizingCharts,
  formatSizingChartsForPrompt,
} from "../lib/sizing-charts.ts";

Deno.test("normalizeSizeEstimate trims, clamps, and nulls Unknown gender", () => {
  const a = normalizeSizeEstimate({
    size: "  M ",
    gender: "Women",
    confidence: 1.5,
    rationale: " waist 29in ",
  });
  assertEquals(a, {
    size: "M",
    gender: "Women",
    confidence: 1,
    rationale: "waist 29in",
  });

  const b = normalizeSizeEstimate({ gender: "Unknown", confidence: "0.7" });
  assertEquals(b.size, "");
  assertEquals(b.gender, null);
  assertEquals(b.confidence, 0.7);

  const c = normalizeSizeEstimate("garbage");
  assertEquals(c.confidence, 0);
  assertEquals(c.gender, null);
});

Deno.test("isMeasurementPhoto matches measurement_* and flatlay", () => {
  assert(isMeasurementPhoto("measurement_chest"));
  assert(isMeasurementPhoto("measurement_inseam"));
  assert(isMeasurementPhoto("flatlay"));
  assert(!isMeasurementPhoto("front"));
  assert(!isMeasurementPhoto(undefined));
});

Deno.test("prioritizeMeasurementPhotos puts measurement/flat-lay first, stable", () => {
  const ordered = prioritizeMeasurementPhotos<{ url: string; type: string }>([
    { url: "a", type: "front" },
    { url: "b", type: "measurement_waist" },
    { url: "c", type: "back" },
    { url: "d", type: "flatlay" },
  ]);
  assertEquals(ordered.map((p) => p.url), ["b", "d", "a", "c"]);
});

Deno.test("findSizingCharts prefers brand-specific Lululemon by category", () => {
  const bottoms = findSizingCharts("Lululemon Align", "leggings");
  assert(bottoms.length >= 1);
  assert(bottoms.every((c) => c.brand === "Lululemon"));
  assert(bottoms.some((c) => /bottom/i.test(c.garment)));

  const tops = findSizingCharts("lululemon", "tank top");
  assert(tops.some((c) => /tops/i.test(c.garment)));
});

Deno.test("findSizingCharts falls back to generic charts for unknown brands", () => {
  const charts = findSizingCharts("SomeIndieBrand", "pants");
  assert(charts.length >= 1);
  // No brand-specific chart for this brand → only generic (brandMatch empty).
  assert(charts.every((c) => c.brandMatch.length === 0));
});

Deno.test("formatSizingChartsForPrompt renders a table or empty string", () => {
  assertEquals(formatSizingChartsForPrompt([]), "");
  const text = formatSizingChartsForPrompt(findSizingCharts("Lululemon", "leggings"));
  assert(text.includes("Lululemon"));
  assert(text.toLowerCase().includes("waist"));
});
