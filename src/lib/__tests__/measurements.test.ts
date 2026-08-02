import { describe, it, expect } from "vitest";
import {
  applyMeasurementsBlock,
  buildMeasurementLines,
  forceMeasurementAspects,
  formatMeasurementValue,
  MEASUREMENTS_BLOCK_START,
  measurementKeyForAspect,
  measurementsNumericallyEqual,
  parseMeasurementAspectValue,
  resolveMeasurementAspects,
} from "@/lib/measurements";

// US-827: web mirror of the edge measurements module. Mirrors the edge test
// suite so the two copies can't drift in behavior.

describe("formatMeasurementValue (US-648 units)", () => {
  it("renders inches by default", () => {
    expect(formatMeasurementValue("chest", 21)).toBe("21 in");
    expect(formatMeasurementValue("inseam", 32.5)).toBe("32.5 in");
  });
  it("converts inches to cm", () => {
    expect(formatMeasurementValue("chest", 20, "cm")).toBe("50.8 cm");
  });
  it("renders shoe sizes and mm without conversion", () => {
    expect(formatMeasurementValue("size_us", 10.5, "cm")).toBe("US 10.5");
    expect(formatMeasurementValue("case_diameter", 42, "cm")).toBe("42 mm");
  });
  it("rejects non-positive / invalid values", () => {
    expect(formatMeasurementValue("chest", 0)).toBeNull();
    expect(formatMeasurementValue("chest", "x")).toBeNull();
  });
});

describe("resolveMeasurementAspects", () => {
  it("fills free-text measurement aspects present in the category", () => {
    expect(
      resolveMeasurementAspects(
        { chest: 21, inseam: 32, sleeve: 25 },
        { "Chest Size": [], Inseam: [], Brand: [] },
      ),
    ).toEqual({ "Chest Size": ["21 in"], Inseam: ["32 in"] });
  });
  it("never fills a SELECTION_ONLY style aspect", () => {
    expect(
      resolveMeasurementAspects(
        { sleeve: 25 },
        { "Sleeve Length": ["Short Sleeve", "Long Sleeve"] },
      ),
    ).toEqual({});
  });
  it("never overwrites an already-set aspect", () => {
    expect(
      resolveMeasurementAspects({ waist: 30 }, { "Waist Size": [] }, { "Waist Size": ["32"] }),
    ).toEqual({});
  });
});

describe("measurementKeyForAspect", () => {
  it("maps known aspect names case-insensitively", () => {
    expect(measurementKeyForAspect("Inseam")).toBe("inseam");
    expect(measurementKeyForAspect("chest size")).toBe("chest");
    expect(measurementKeyForAspect("Pit to Pit")).toBe("chest");
  });
  it("returns null for unrelated aspects", () => {
    expect(measurementKeyForAspect("Brand")).toBeNull();
    expect(measurementKeyForAspect("")).toBeNull();
  });
});

describe("parseMeasurementAspectValue", () => {
  it("parses bare numbers and inch/cm suffixes into inches", () => {
    expect(parseMeasurementAspectValue("inseam", "32")).toBe(32);
    expect(parseMeasurementAspectValue("inseam", "32 in")).toBe(32);
    expect(parseMeasurementAspectValue("inseam", "81.28 cm")).toBe(32);
  });
  it("parses shoe and mm kinds", () => {
    expect(parseMeasurementAspectValue("size_us", "US 10.5")).toBe(10.5);
    expect(parseMeasurementAspectValue("case_diameter", "42 mm")).toBe(42);
  });
  it("rejects non-numeric strings", () => {
    expect(parseMeasurementAspectValue("sleeve", "Short Sleeve")).toBeNull();
    expect(parseMeasurementAspectValue("inseam", "")).toBeNull();
  });
});

describe("measurementsNumericallyEqual", () => {
  it("treats near-equal numbers as equal", () => {
    expect(measurementsNumericallyEqual(32, "32")).toBe(true);
    expect(measurementsNumericallyEqual(32, 32.005)).toBe(true);
    expect(measurementsNumericallyEqual(32, 30)).toBe(false);
  });
});

describe("forceMeasurementAspects (live overwrite)", () => {
  it("overwrites an already-set free-text aspect", () => {
    expect(
      forceMeasurementAspects(
        { inseam: 34 },
        { Inseam: [] },
        { Inseam: ["32 in"] },
      ),
    ).toEqual({ aspects: { Inseam: ["34 in"] }, cleared: [] });
  });
  it("skips SELECTION_ONLY aspects", () => {
    expect(
      forceMeasurementAspects(
        { sleeve: 25 },
        { "Sleeve Length": ["Short Sleeve", "Long Sleeve"] },
        {},
      ),
    ).toEqual({ aspects: {}, cleared: [] });
  });
  it("clears inventory_derived aspects when the measurement is blanked", () => {
    expect(
      forceMeasurementAspects(
        {},
        { Inseam: [] },
        { Inseam: ["32 in"] },
        "in",
        { Inseam: "inventory_derived" },
      ),
    ).toEqual({ aspects: {}, cleared: ["Inseam"] });
  });
  it("is a no-op when the aspect already matches the formatted value", () => {
    expect(
      forceMeasurementAspects(
        { inseam: 32 },
        { Inseam: [] },
        { Inseam: ["32 in"] },
      ),
    ).toEqual({ aspects: {}, cleared: [] });
  });
  it("honors cm preference when projecting", () => {
    expect(
      forceMeasurementAspects({ inseam: 30 }, { Inseam: [] }, {}, "cm"),
    ).toEqual({ aspects: { Inseam: ["76.2 cm"] }, cleared: [] });
  });
  // A men's hoodie exposes "Sleeve Length" as FREE_TEXT holding "Long Sleeve".
  // With no sleeve measurement captured, the old rule cleared it as a stale
  // measurement mirror and the seller's specific silently vanished.
  it("never clears a categorical value in a measurement-named aspect", () => {
    expect(
      forceMeasurementAspects(
        {},
        { "Sleeve Length": [] },
        { "Sleeve Length": ["Long Sleeve"] },
        "in",
        { "Sleeve Length": "inventory_derived" },
      ),
    ).toEqual({ aspects: {}, cleared: [] });
  });
  it("never overwrites a categorical value with a measurement", () => {
    expect(
      forceMeasurementAspects(
        { sleeve: 25 },
        { "Sleeve Length": [] },
        { "Sleeve Length": ["Long Sleeve"] },
      ),
    ).toEqual({ aspects: {}, cleared: [] });
  });
  it("still fills the same aspect when it is empty", () => {
    expect(
      forceMeasurementAspects({ sleeve: 25 }, { "Sleeve Length": [] }, {}),
    ).toEqual({ aspects: { "Sleeve Length": ["25 in"] }, cleared: [] });
  });
});

describe("applyMeasurementsBlock (idempotency)", () => {
  it("appends a block", () => {
    const out = applyMeasurementsBlock("Hoodie.", { chest: 21 });
    expect(out).toContain("Hoodie.");
    expect(out).toContain("- Chest (pit to pit): 21 in");
  });
  it("never duplicates on re-apply", () => {
    const once = applyMeasurementsBlock("Hoodie.", { chest: 21 });
    const twice = applyMeasurementsBlock(once, { chest: 21 });
    expect(twice).toBe(once);
    expect(twice.split(MEASUREMENTS_BLOCK_START).length - 1).toBe(1);
  });
  it("refreshes on changed measurements and drops stale values", () => {
    const first = applyMeasurementsBlock("Tee.", { chest: 20 });
    const updated = applyMeasurementsBlock(first, { chest: 22 });
    expect(updated).toContain("22 in");
    expect(updated).not.toContain("20 in");
  });
  it("removes the block when cleared", () => {
    const withBlock = applyMeasurementsBlock("Tee.", { chest: 20 });
    expect(applyMeasurementsBlock(withBlock, {})).toBe("Tee.");
  });
  it("honors the cm preference", () => {
    expect(applyMeasurementsBlock("Pants.", { inseam: 30 }, "cm")).toContain(
      "- Inseam: 76.2 cm",
    );
  });
});

describe("buildMeasurementLines ordering", () => {
  it("renders in canonical key order", () => {
    expect(buildMeasurementLines({ inseam: 32, chest: 21 })).toEqual([
      "- Chest (pit to pit): 21 in",
      "- Inseam: 32 in",
    ]);
  });
});
