// US-2827. The one that matters is isOutsideBand returning NULL rather than
// false when there is no cohort band. A boolean answer to "is this measurement
// unusual" when nobody can say is a clean bill of health handed out for exactly
// the buckets with no evidence behind them.

import { describe, expect, it } from "vitest";
import { MEASUREMENT_SPECS } from "@/lib/measurements";
import {
  bandFor,
  driftReturnFinding,
  EMPTY_DRIFT,
  isOutsideBand,
  measurementLabel,
  normaliseDrift,
  quotableDrift,
  significantDrift,
  type DriftRow,
  type MeasurementDrift,
} from "@/lib/measurement-drift";

function row(over: Partial<DriftRow> & { key: string }): DriftRow {
  return {
    garmentCategory: "tops",
    size: "M",
    ownCount: 12,
    ownMedian: 21,
    cohortCount: 400,
    cohortSellers: 18,
    cohortSuppressed: false,
    cohortMedian: 20,
    cohortP25: 19.5,
    cohortP75: 20.5,
    driftInches: 1,
    ...over,
  };
}

function report(over: Partial<MeasurementDrift> = {}): MeasurementDrift {
  return { ...EMPTY_DRIFT, ...over };
}

describe("measurementLabel", () => {
  it("reads the label out of the shared vocabulary", () => {
    expect(measurementLabel("chest")).toBe(MEASUREMENT_SPECS.chest!.label);
    expect(measurementLabel("leg_opening")).toBe(
      MEASUREMENT_SPECS.leg_opening!.label,
    );
  });

  it("falls back readably for a key the vocabulary does not have", () => {
    // This is what a drift between 00658's key list and MEASUREMENT_SPECS looks
    // like at runtime: a readable row rather than a blank one.
    expect(measurementLabel("cuff_width")).toBe("Cuff width");
  });
});

describe("quotableDrift and significantDrift", () => {
  it("sorts by absolute drift, so measuring SMALL is as visible as large", () => {
    const r = report({
      rows: [
        row({ key: "chest", driftInches: 0.5 }),
        row({ key: "waist", driftInches: -2.5 }),
        row({ key: "sleeve", driftInches: 1.5 }),
      ],
    });
    expect(quotableDrift(r).map((x) => x.key)).toEqual([
      "waist",
      "sleeve",
      "chest",
    ]);
  });

  it("drops rows with no quotable drift", () => {
    const r = report({
      rows: [
        row({ key: "chest", driftInches: 1.5 }),
        row({ key: "hip", driftInches: null, cohortSuppressed: true, cohortMedian: null }),
      ],
    });
    expect(quotableDrift(r).map((x) => x.key)).toEqual(["chest"]);
  });

  it("significantDrift keeps only rows past the threshold, either direction", () => {
    const r = report({
      driftInches: 1,
      rows: [
        row({ key: "chest", driftInches: 1.5 }),
        row({ key: "waist", driftInches: -1.5 }),
        row({ key: "sleeve", driftInches: 0.75 }),
        row({ key: "hip", driftInches: 1 }),
      ],
    });
    expect(significantDrift(r).map((x) => x.key).sort()).toEqual([
      "chest",
      "waist",
    ]);
  });
});

describe("driftReturnFinding", () => {
  it("reports the multiplier when both halves have enough sales", () => {
    const r = report({
      returns: {
        offCount: 40, offReturns: 8, offRate: 0.2,
        withinCount: 120, withinReturns: 6, withinRate: 0.05,
      },
    });
    expect(driftReturnFinding(r)?.multiplier).toBeCloseTo(4, 6);
  });

  it("is null when either half is under the sample floor", () => {
    expect(
      driftReturnFinding(
        report({
          returns: { ...EMPTY_DRIFT.returns, offRate: 0.2, withinRate: null },
        }),
      ),
    ).toBeNull();
  });

  it("refuses to divide by a zero within-tolerance rate", () => {
    expect(
      driftReturnFinding(
        report({
          returns: {
            offCount: 40, offReturns: 8, offRate: 0.2,
            withinCount: 120, withinReturns: 0, withinRate: 0,
          },
        }),
      ),
    ).toBeNull();
  });

  it("reports nothing when drifting does not cost anything", () => {
    expect(
      driftReturnFinding(
        report({
          returns: {
            offCount: 40, offReturns: 2, offRate: 0.05,
            withinCount: 120, withinReturns: 12, withinRate: 0.1,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("isOutsideBand", () => {
  const band = { cohortP25: 19.5, cohortP75: 20.5, cohortSuppressed: false };

  it("flags a value outside the middle half, either side", () => {
    expect(isOutsideBand(21.2, band)).toBe(true);
    expect(isOutsideBand(18.9, band)).toBe(true);
  });

  it("passes a value inside it, boundaries included", () => {
    expect(isOutsideBand(20, band)).toBe(false);
    expect(isOutsideBand(19.5, band)).toBe(false);
    expect(isOutsideBand(20.5, band)).toBe(false);
  });

  it("returns NULL when the cohort is suppressed, never false", () => {
    // The whole point. `false` reads as "checked and fine"; there was no check.
    expect(
      isOutsideBand(21.2, { ...band, cohortSuppressed: true }),
    ).toBeNull();
  });

  it("returns null when the band is missing", () => {
    expect(
      isOutsideBand(21.2, { cohortP25: null, cohortP75: null, cohortSuppressed: false }),
    ).toBeNull();
  });

  it("returns null for a value that is not a number", () => {
    expect(isOutsideBand(Number.NaN, band)).toBeNull();
  });
});

// ── normaliseDrift: the boundary that stopped the composer crashing ─────────
//
// fetchMeasurementDrift reaches PostgREST through `supabase as unknown as
// RpcClient`, so `data: MeasurementDrift | null` is an assertion and not a
// check. It used to end `return data ?? EMPTY_DRIFT`, which only catches null.
//
// The e2e suite mocks every unmatched /rest/v1/** call with an empty ARRAY,
// this RPC included. `[]` is not null, so it survived the `??` wearing the
// type, `bandFor` then ran `report.bands.find(...)` on undefined, and the
// render-phase throw took the WHOLE /items/:id/draft route down through the
// ErrorBoundary. Three e2e scenarios failed identically, because the payload
// has nothing to do with the scenario.
describe("normaliseDrift", () => {
  it("turns the empty array that crashed the composer into a whole report", () => {
    // The exact payload from the e2e catch-all. This is the regression case.
    const d = normaliseDrift([]);
    expect(d.bands).toEqual([]);
    expect(d.rows).toEqual([]);
    expect(() => bandFor(d, "chest")).not.toThrow();
    expect(bandFor(d, "chest")).toBeNull();
  });

  it("survives null, undefined and a scalar", () => {
    for (const raw of [null, undefined, 0, "", "nope", true]) {
      expect(normaliseDrift(raw), `${JSON.stringify(raw)}`).toEqual(EMPTY_DRIFT);
    }
  });

  it("fills in only the missing pieces, keeping what the server did send", () => {
    // A partial payload is the realistic production shape — an older overloaded
    // measurement_drift answering without the `bands` 00658 added.
    const d = normaliseDrift({
      garmentCategory: "bottoms",
      driftInches: 2,
      rows: [row({ key: "waist" })],
    });
    expect(d.garmentCategory).toBe("bottoms");
    expect(d.driftInches).toBe(2);
    expect(d.rows).toHaveLength(1);
    expect(d.bands).toEqual([]);
    expect(d.returns).toEqual(EMPTY_DRIFT.returns);
    // And every reader that assumes the shape now holds.
    expect(() => quotableDrift(d)).not.toThrow();
    expect(() => driftReturnFinding(d)).not.toThrow();
  });

  it("rejects an array where an object belongs, rather than spreading it", () => {
    // `rows: {}` and `returns: []` are the two directions that would otherwise
    // produce an object with no .filter and a .returns with no .offRate.
    const d = normaliseDrift({ rows: {}, bands: "no", returns: [] });
    expect(Array.isArray(d.rows)).toBe(true);
    expect(Array.isArray(d.bands)).toBe(true);
    expect(d.returns).toEqual(EMPTY_DRIFT.returns);
    expect(driftReturnFinding(d)).toBeNull();
  });

  it("a whole report round-trips unchanged", () => {
    const full = report({ rows: [row({ key: "chest" })], driftInches: 1.5 });
    expect(normaliseDrift(full)).toEqual(full);
  });
});
