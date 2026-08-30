import { describe, it, expect } from "vitest";
import {
  tripDeductionCents,
  formatRate,
  mileageWarnings,
  partIvRows,
  partIvConflict,
  type MileageSummary,
  type VehicleUseYear,
} from "./mileage";

// US-2989. The database side is checked against Postgres by
// scripts/check-mileage-log.mjs; this covers the arithmetic and the disclosures.

function summary(over: Partial<MileageSummary> = {}): MileageSummary {
  return {
    from: "2022-01-01",
    to: "2023-01-01",
    trip_count: 5,
    total_miles: 258.1,
    deduction_cents: 15498,
    trips_without_a_rate: 0,
    trips_on_a_provisional_rate: 0,
    miles_on_a_provisional_rate: 0,
    ...over,
  };
}

describe("tripDeductionCents", () => {
  it("matches the figures Postgres produced for the fixture", () => {
    // 100 miles at 58.5 cents, then the same trip a day later at 62.5. The
    // mid-year change is the case a constant cannot express.
    expect(tripDeductionCents(100, 585)).toBe(5850);
    expect(tripDeductionCents(100, 625)).toBe(6250);
    expect(tripDeductionCents(37.3, 585)).toBe(2182);
    expect(tripDeductionCents(42, 700)).toBe(2940);
  });

  it("rounds PER TRIP, which is what keeps it equal to the ledger", () => {
    // 10.4 miles at 58.5 cents is 608.4 cents. Two of them are 1216 rounded per
    // trip and 1217 rounded once on the total. The ledger writes one entry per
    // trip, so per-trip is the answer that agrees with it -- and a seller who
    // finds two of our screens a cent apart stops believing both.
    const each = tripDeductionCents(10.4, 585);
    expect(each).toBe(608);
    expect(each * 2).toBe(1216);
    expect(Math.round((10.4 * 2 * 585) / 10)).toBe(1217);
  });

  it("always returns whole cents", () => {
    for (const miles of [0.1, 1.7, 12.3, 99.9, 1234.5]) {
      for (const rate of [560, 585, 625, 655, 670, 700]) {
        expect(Number.isInteger(tripDeductionCents(miles, rate))).toBe(true);
      }
    }
  });
});

describe("formatRate", () => {
  it("reads back as the published rate, not as tenths", () => {
    expect(formatRate(585)).toBe("58.5 cents a mile");
    expect(formatRate(700)).toBe("70.0 cents a mile");
    expect(formatRate(560)).toBe("56.0 cents a mile");
  });
});

describe("mileageWarnings", () => {
  it("says nothing when there is nothing to disclose", () => {
    expect(mileageWarnings(summary())).toEqual([]);
  });

  it("reports trips that fall outside every rate", () => {
    const w = mileageWarnings(summary({ trips_without_a_rate: 1 }));
    expect(w[0]?.kind).toBe("no_rate");
    // The point being that they add NOTHING, rather than being valued at a
    // guess. A rate we do not have is not a rate of zero.
    expect(w[0]?.text).toMatch(/add nothing/i);
  });

  it("reports a provisional rate with the miles it affects", () => {
    const w = mileageWarnings(
      summary({ trips_on_a_provisional_rate: 1, miles_on_a_provisional_rate: 42 }),
    );
    expect(w[0]?.kind).toBe("provisional");
    expect(w[0]?.text).toMatch(/42 miles/);
    expect(w[0]?.text).toMatch(/before you file/i);
  });

  it("reports both at once when both apply", () => {
    const w = mileageWarnings(
      summary({
        trips_without_a_rate: 2,
        trips_on_a_provisional_rate: 3,
        miles_on_a_provisional_rate: 120,
      }),
    );
    expect(w.map((x) => x.kind)).toEqual(["no_rate", "provisional"]);
  });

  it("pluralises", () => {
    expect(mileageWarnings(summary({ trips_without_a_rate: 1 }))[0]?.text).toMatch(
      /1 trip fall/,
    );
    expect(mileageWarnings(summary({ trips_without_a_rate: 3 }))[0]?.text).toMatch(
      /3 trips fall/,
    );
  });
});

describe("partIvRows", () => {
  const year: VehicleUseYear = {
    tax_year: 2022,
    method: "standard",
    total_miles: 9000,
    commuting_miles: 1200,
    other_personal_miles: 4000,
    placed_in_service_on: null,
  };

  it("derives business miles and asks for the other three", () => {
    // Only the seller knows how far they drove in total. Deriving it would be
    // inventing a number.
    const rows = partIvRows(summary(), year);
    expect(rows[0]).toMatchObject({ line: "44a", value: 258.1, derived: true });
    expect(rows.slice(1).every((r) => !r.derived)).toBe(true);
  });

  it("shows a missing figure as missing, never as zero", () => {
    // Zero commuting miles is a real answer. A blank is not the same thing, and
    // printing 0 for a blank puts a claim on a form the seller never made.
    const rows = partIvRows(summary(), null);
    expect(rows[1]?.value).toBeNull();
    expect(rows[2]?.value).toBeNull();
    expect(rows[3]?.value).toBeNull();
  });

  it("keeps a genuine zero", () => {
    const rows = partIvRows(summary(), { ...year, commuting_miles: 0 });
    expect(rows[1]?.value).toBe(0);
  });

  it("names the Part IV line on the three that have one", () => {
    const rows = partIvRows(summary(), year);
    expect(rows.slice(0, 3).map((r) => r.line)).toEqual(["44a", "44b", "44c"]);
  });
});

describe("partIvConflict", () => {
  const year: VehicleUseYear = {
    tax_year: 2022,
    method: "standard",
    total_miles: 9000,
    commuting_miles: 1200,
    other_personal_miles: 4000,
    placed_in_service_on: null,
  };

  it("is silent when the figures are consistent", () => {
    expect(partIvConflict(summary(), year)).toBeNull();
  });

  it("is silent when the seller has not given a total", () => {
    expect(partIvConflict(summary(), { ...year, total_miles: null })).toBeNull();
  });

  it("catches parts adding up to more than the whole", () => {
    // Four figures that contradict each other are worse on a form than three
    // and a question.
    const msg = partIvConflict(summary({ total_miles: 5000 }), year);
    expect(msg).toMatch(/10200.0/);
    expect(msg).toMatch(/1200.0 more/);
    expect(msg).toMatch(/One of these is wrong/);
  });

  it("allows the parts to be less than the total", () => {
    // Miles the seller cannot classify are their business, not an error.
    expect(partIvConflict(summary({ total_miles: 100 }), year)).toBeNull();
  });

  it("treats a missing part as zero rather than refusing to check", () => {
    const msg = partIvConflict(summary({ total_miles: 100 }), {
      ...year,
      total_miles: 200,
      commuting_miles: null,
      other_personal_miles: null,
    });
    expect(msg).toBeNull();
  });
});
