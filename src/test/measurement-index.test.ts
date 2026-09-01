import { describe, expect, it } from "vitest";
import {
  checkIndexDrift,
  DRIFT_MIN_INCHES,
  indexDriftMessage,
  provenanceLine,
  statFor,
  suggestableFields,
  type IndexStatField,
  type IndexStatsResponse,
} from "@/lib/measurement-index";

// US-3039: the two things the composer does with the Fit & Measurement Index.
//
// The failure that matters here is not a wrong number, it is a warning that
// fires too often. A quarter of genuine garments sit outside the interquartile
// range by construction, so a naive rule would flag a quarter of correctly
// measured items — and a seller who learns to click past the warning still has
// it in front of them on the day their item really is mismeasured. Every test
// below about NOT warning is protecting that.
//
// See the header of measurement-index.ts for why this is separate from the
// US-2827 drift module, which pools every brand together.

function field(over: Partial<IndexStatField> = {}): IndexStatField {
  return {
    field: "waist",
    label: "Waist (flat)",
    median: 17,
    p25: 16.75,
    p75: 17.25,
    sampleCount: 14,
    contributorCount: 5,
    ...over,
  };
}

function stats(fields: IndexStatField[]): IndexStatsResponse {
  return {
    cohort: {
      brandKey: "levis",
      styleKey: "550",
      department: "Men",
      group: "bottom",
      sizeLabel: "34X32",
      styleMatched: true,
    },
    fields,
  };
}

describe("US-3039: the drift warning", () => {
  it("says nothing about a value inside the band", () => {
    expect(checkIndexDrift(field(), 17).drifted).toBe(false);
    expect(checkIndexDrift(field(), 16.75).drifted).toBe(false);
    expect(checkIndexDrift(field(), 17.25).drifted).toBe(false);
  });

  it("says nothing about a value just outside the quartiles", () => {
    // THE IMPORTANT ONE. p75 is 17.25 and 17.5 is past it, but by less than a
    // tape measure resolves. A rule that fired here would fire constantly, and
    // a warning that cries wolf is worse than no warning at all.
    expect(checkIndexDrift(field(), 17.5).drifted).toBe(false);
    expect(checkIndexDrift(field(), 16.5).drifted).toBe(false);
  });

  it("warns about a value far outside, and says which way", () => {
    const high = checkIndexDrift(field(), 19);
    expect(high.drifted).toBe(true);
    expect(high.direction).toBe("above");

    const low = checkIndexDrift(field(), 15);
    expect(low.drifted).toBe(true);
    expect(low.direction).toBe("below");
  });

  it("keeps an absolute floor when the cohort is very tight", () => {
    // Every garment measured identically, so the IQR is zero. A purely
    // proportional rule would warn on any difference at all.
    const tight = field({ p25: 17, p75: 17, median: 17 });
    expect(checkIndexDrift(tight, 17 + DRIFT_MIN_INCHES - 0.01).drifted).toBe(false);
    expect(checkIndexDrift(tight, 17 + DRIFT_MIN_INCHES + 0.5).drifted).toBe(true);
  });

  it("widens with the cohort when the cohort is genuinely varied", () => {
    const loose = field({ p25: 16, p75: 18, median: 17 });
    expect(checkIndexDrift(loose, 20).drifted).toBe(false);
    expect(checkIndexDrift(loose, 22).drifted).toBe(true);
  });

  it("stays silent when there is nothing to compare against", () => {
    expect(checkIndexDrift(undefined, 19).drifted).toBe(false);
    expect(checkIndexDrift(field(), null).drifted).toBe(false);
    expect(checkIndexDrift(field(), undefined).drifted).toBe(false);
    expect(checkIndexDrift(field(), Number.NaN).drifted).toBe(false);
    expect(checkIndexDrift(field(), 0).drifted).toBe(false);
    expect(checkIndexDrift(field(), -5).drifted).toBe(false);
  });

  it("names the median and the sample count in the message", () => {
    const msg = indexDriftMessage(field(), 19);
    expect(msg).toContain("17");
    expect(msg).toContain("14");
    expect(indexDriftMessage(field(), 17)).toBeNull();
  });

  it("only ever returns a string or null — it never blocks", () => {
    // Pinned because the obvious next request is "stop them saving it", and a
    // measurement estimate that overrules the seller's own tape is the version
    // of this feature that gets switched off.
    const msg = indexDriftMessage(field(), 40);
    expect(typeof msg === "string" || msg === null).toBe(true);
  });
});

describe("US-3039: autofill suggestions", () => {
  it("suggests only fields that are empty", () => {
    const s = stats([field(), field({ field: "inseam", label: "Inseam", median: 32 })]);
    expect(suggestableFields(s, { waist: 17.5 }).map((f) => f.field)).toEqual(["inseam"]);
  });

  it("treats blank, zero and junk as empty", () => {
    const s = stats([field()]);
    expect(suggestableFields(s, {}).length).toBe(1);
    expect(suggestableFields(s, { waist: "" }).length).toBe(1);
    expect(suggestableFields(s, { waist: 0 }).length).toBe(1);
    expect(suggestableFields(s, { waist: "abc" }).length).toBe(1);
    expect(suggestableFields(s, { waist: null }).length).toBe(1);
  });

  it("never suggests over a value the seller already typed", () => {
    const s = stats([field()]);
    expect(suggestableFields(s, { waist: 19 }).length).toBe(0);
  });

  it("suggests nothing when no cohort is published", () => {
    // Absent and silent, not an empty state. There is no "no data yet" message
    // to show a seller who was not asking a question.
    expect(suggestableFields(null, {}).length).toBe(0);
    expect(suggestableFields({ cohort: null, fields: [] }, {}).length).toBe(0);
    expect(suggestableFields(stats([]), {}).length).toBe(0);
  });
});

describe("US-3039: the provenance line", () => {
  it("reports the SMALLEST sample count across the shown fields", () => {
    // A cohort can clear the floor on waist with 14 garments and on rise with
    // 5. Printing 14 beside a table containing the rise number overstates the
    // weakest thing on screen, which is the number a reader leans on hardest.
    const line = provenanceLine(
      stats([field({ sampleCount: 14 }), field({ field: "rise", sampleCount: 5 })]),
      "bottom",
    );
    expect(line).toBe("Median of 5 measured pairs");
  });

  it("uses the right noun for the garment type", () => {
    expect(provenanceLine(stats([field()]), "bottom")).toContain("pairs");
    expect(provenanceLine(stats([field()]), "top")).toContain("garments");
  });

  it("is singular when one garment backs it", () => {
    expect(provenanceLine(stats([field({ sampleCount: 1 })]), "bottom")).toBe(
      "Median of 1 measured pair",
    );
  });

  it("is null when nothing is published", () => {
    expect(provenanceLine(null, "bottom")).toBeNull();
    expect(provenanceLine(stats([]), "bottom")).toBeNull();
  });
});

describe("US-3039: statFor", () => {
  it("finds a field and returns undefined for one that is not published", () => {
    const s = stats([field()]);
    expect(statFor(s, "waist")?.median).toBe(17);
    expect(statFor(s, "rise")).toBeUndefined();
    expect(statFor(null, "waist")).toBeUndefined();
  });
});
