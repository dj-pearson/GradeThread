// US-2790: postage bands, the band-edge nudge, and the mirror.
//
// The prices are read off USPS Notice 123 and recorded in
// docs/shipping/usps-rates-CONFIRMED.csv. These cases pin the RULES the table
// obeys rather than re-listing the prices — a test that restated every number
// would pass whenever the table and the test were edited together, which is
// precisely the drift it would be there to catch.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  estimatePostage,
  GROUND_ADVANTAGE_ZONE4,
  RATE_EFFECTIVE_FROM,
  rateBreakWarning,
} from "../shipping-rates";

describe("estimatePostage", () => {
  it("carries a real effective date, not an invented one", () => {
    expect(RATE_EFFECTIVE_FROM).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Printed on the notice as "Effective July 12, 2026". Pinned because the
    // whole point of this field is that it was read; a silently changed date
    // would make the table look fresher than its numbers.
    expect(RATE_EFFECTIVE_FROM).toBe("2026-07-12");
  });

  it("prices a light parcel in the lowest band", () => {
    const q = estimatePostage(6);
    expect(q).not.toBeNull();
    expect(q!.priceUsd).toBeGreaterThan(0);
    expect(q!.bandMaxOz).toBeGreaterThanOrEqual(6);
  });

  it("charges more for a heavier parcel", () => {
    const light = estimatePostage(6)!;
    const heavy = estimatePostage(40)!;
    expect(heavy.priceUsd).toBeGreaterThan(light.priceUsd);
  });

  it("reports how many ounces sit between here and the next band", () => {
    const q = estimatePostage(15.5)!;
    expect(q.ozToNextBand).toBeCloseTo(q.bandMaxOz - 15.5, 3);
  });

  it("returns null above the heaviest band rather than extrapolating", () => {
    // The published table runs to 70 lb and only the bands through 5 lb are
    // sourced. A computed guess above that would be an invented price.
    expect(estimatePostage(100000)).toBeNull();
  });

  it("refuses a nonsense weight rather than pricing it", () => {
    for (const oz of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimatePostage(oz), `oz ${oz}`).toBeNull();
    }
  });

  it("a parcel exactly on a band edge pays that band, not the next one", () => {
    // The bands are inclusive ceilings. Off-by-one here would overcharge every
    // parcel that lands exactly on 4, 8, 12 or 16 oz, which is a lot of them.
    for (const band of GROUND_ADVANTAGE_ZONE4) {
      const q = estimatePostage(band.maxOz)!;
      expect(q.bandMaxOz, `${band.maxOz} oz`).toBe(band.maxOz);
      expect(q.priceUsd, `${band.maxOz} oz`).toBe(band.priceUsd);
      expect(q.ozToNextBand, `${band.maxOz} oz`).toBe(0);
    }
  });
});

describe("US-2790: the table's own shape", () => {
  it("is ascending by band ceiling, so the first match is the right one", () => {
    // estimatePostage returns the FIRST band whose ceiling fits. That is only
    // correct while the list is sorted, and nothing else enforces it.
    const ceilings = GROUND_ADVANTAGE_ZONE4.map((b) => b.maxOz);
    expect([...ceilings].sort((a, b) => a - b)).toEqual(ceilings);
  });

  it("never gets cheaper as it gets heavier", () => {
    let previous = 0;
    for (const band of GROUND_ADVANTAGE_ZONE4) {
      expect(band.priceUsd, `${band.maxOz} oz`).toBeGreaterThanOrEqual(previous);
      previous = band.priceUsd;
    }
  });

  it("every price is a real two-decimal amount", () => {
    for (const band of GROUND_ADVANTAGE_ZONE4) {
      expect(Number.isFinite(band.priceUsd), `${band.maxOz} oz`).toBe(true);
      expect(band.priceUsd, `${band.maxOz} oz`).toBeGreaterThan(0);
      expect(Math.round(band.priceUsd * 100), `${band.maxOz} oz`).toBeCloseTo(
        band.priceUsd * 100,
        6,
      );
    }
  });

  it("matches the sourced CSV row for row", () => {
    // The CSV is the record of what was READ; the table is what the code uses.
    // If they disagree, one of them was edited without the other and the
    // provenance is worthless. Zone 4 rows only — the file also holds a
    // zone 1-2 row for comparison.
    const csv = readFileSync(
      resolve(process.cwd(), "docs/shipping/usps-rates-CONFIRMED.csv"),
      "utf8",
    );
    const rows = csv
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(","))
      .filter((c) => c[0] === "ground_advantage_retail" && c[1] === "4")
      .map((c) => ({ maxOz: Number(c[2]), priceUsd: Number(c[3]) }));

    expect(rows.length, "no zone 4 rows found in the CSV").toBeGreaterThan(0);
    expect(rows).toEqual(GROUND_ADVANTAGE_ZONE4.map((b) => ({ ...b })));
  });

  it("every sourced row is cross-checked, not read once", () => {
    // The directory's rule: a single model-mediated read of a dense rate table
    // is where a plausible wrong number comes from. Anything still marked
    // single_read must not be priced against, so it must not be in the table.
    const csv = readFileSync(
      resolve(process.cwd(), "docs/shipping/usps-rates-CONFIRMED.csv"),
      "utf8",
    );
    const singles = csv
      .trim()
      .split("\n")
      .slice(1)
      .filter((l) => l.endsWith("single_read"));
    expect(singles, "single_read rows must be cross-checked before use").toEqual([]);
  });
});

describe("rateBreakWarning", () => {
  it("warns when a small trim drops a band", () => {
    // Just over 16 oz: the seller pays the 32 oz band for a few ounces.
    const msg = rateBreakWarning(16.4);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/save/i);
  });

  it("stays quiet in the middle of a band", () => {
    expect(rateBreakWarning(8)).toBeNull();
  });

  it("stays quiet when the band below costs the SAME", () => {
    // 4 oz and 8 oz are both $8.30 here, so trimming from 4.4 oz saves
    // nothing. Telling a seller to shave ounces for no money is worse than
    // silence — it spends the one warning they will read.
    expect(rateBreakWarning(4.4)).toBeNull();
  });

  it("stays quiet well past an edge, where trimming is not realistic", () => {
    expect(rateBreakWarning(20)).toBeNull();
  });

  it("quotes a saving that matches the two bands it sits between", () => {
    const msg = rateBreakWarning(16.5)!;
    // 13.00 - 10.60 = 2.40
    expect(msg).toContain("$2.40");
  });

  it("refuses a nonsense weight", () => {
    for (const oz of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rateBreakWarning(oz), `oz ${oz}`).toBeNull();
    }
  });
});

describe("US-2790: this module is web-only, and stays mirror-ready", () => {
  // ⚠ THERE IS DELIBERATELY NO EDGE MIRROR. One was created and then removed
  // the same session: check-unwired-modules.mjs failed the build because
  // nothing under services/edge-functions imports it, and it was right to.
  //
  // The edge does not price postage. flipdesk-logistics.ts needs the parcel
  // WEIGHT (so parcel-estimate.ts IS mirrored and IS imported there), and eBay
  // prices the label itself. The rate table exists for the web margin floor.
  //
  // Allowlisting it as PENDING would have been the other option, and the reason
  // would have been "built ahead of its caller" — for a caller blocked on eBay
  // documentation that has been unreachable for six attempts across three
  // sessions. A dead mirror kept on that promise is what the guard is for.
  //
  // Restoring it is one `cp` plus a byte-identical assertion, whenever an edge
  // consumer actually exists. The import-free rule below is what keeps that
  // cheap, so it is enforced now rather than at the point of copying.
  it("imports nothing, so a future Deno mirror type-checks unchanged", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/shipping-rates.ts"), "utf8");
    const imports = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) && !l.trimStart().startsWith("//"));
    expect(imports, "shipping-rates.ts must stay import-free").toEqual([]);
  });
});
