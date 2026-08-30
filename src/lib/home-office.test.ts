import { describe, it, expect } from "vitest";
import {
  homeOfficeDeductionCents,
  describeRate,
  maxDeductionCents,
  homeOfficeNotices,
  type HomeOfficeRate,
  type HomeOfficeOverlap,
} from "./home-office";

// US-2990. The database side is checked against Postgres by
// scripts/check-home-office.mjs; this mirrors the arithmetic so the screen can
// show a figure as the seller types, and covers what it must disclose.

const RATE: HomeOfficeRate = {
  cents_per_sq_ft: 500,
  max_sq_ft: 300,
  is_provisional: false,
  note: "$5.00 per square foot, up to 300 square feet.",
};

function overlap(over: Partial<HomeOfficeOverlap> = {}): HomeOfficeOverlap {
  return {
    tax_year: 2025,
    has_home_office: true,
    method: "simplified",
    square_feet: 120,
    deduction_cents: 60000,
    rent_cents: 0,
    rent_entries: 0,
    utilities_cents: 0,
    utilities_entries: 0,
    overlaps: false,
    ...over,
  };
}

describe("homeOfficeDeductionCents", () => {
  it("matches the figures Postgres produced", () => {
    expect(homeOfficeDeductionCents(300, 12, RATE)).toBe(150000);
    expect(homeOfficeDeductionCents(400, 12, RATE)).toBe(150000);
    expect(homeOfficeDeductionCents(120, 12, RATE)).toBe(60000);
    expect(homeOfficeDeductionCents(120, 3, RATE)).toBe(15000);
  });

  it("CAPS THE FOOTAGE FIRST, then prorates the months", () => {
    // The one that matters. 400 sq ft for six months is 300 capped and then
    // halved: $750. Prorating first and capping after gives $1,000. Both look
    // plausible on a screen; the difference is $250 on a $1,500 maximum.
    expect(homeOfficeDeductionCents(400, 6, RATE)).toBe(75000);
    // The wrong order, written out so the difference is visible in the test
    // rather than only in the comment.
    const wrongOrder = Math.min(
      Math.round((400 * 500 * 6) / 12),
      RATE.max_sq_ft * RATE.cents_per_sq_ft,
    );
    expect(wrongOrder).toBe(100000);
    expect(homeOfficeDeductionCents(400, 6, RATE)).not.toBe(wrongOrder);
  });

  it("is zero at both boundaries", () => {
    expect(homeOfficeDeductionCents(120, 0, RATE)).toBe(0);
    expect(homeOfficeDeductionCents(0, 12, RATE)).toBe(0);
  });

  it("clamps months rather than trusting them", () => {
    // A 13-month year is a typo, not a longer year.
    expect(homeOfficeDeductionCents(120, 24, RATE)).toBe(
      homeOfficeDeductionCents(120, 12, RATE),
    );
    expect(homeOfficeDeductionCents(120, -3, RATE)).toBe(0);
  });

  it("returns whole cents for every month count", () => {
    for (let m = 0; m <= 12; m++) {
      for (const sqft of [37, 120.5, 299, 300]) {
        expect(Number.isInteger(homeOfficeDeductionCents(sqft, m, RATE))).toBe(true);
      }
    }
  });

  it("never exceeds the cap, whatever the inputs", () => {
    const max = maxDeductionCents(RATE);
    for (const sqft of [1, 300, 301, 5000, 99999]) {
      expect(homeOfficeDeductionCents(sqft, 12, RATE)).toBeLessThanOrEqual(max);
    }
  });
});

describe("describeRate", () => {
  it("reads as money and feet, not as cents", () => {
    expect(describeRate(RATE)).toBe(
      "$5.00 a square foot, up to 300 square feet",
    );
  });
});

describe("homeOfficeNotices", () => {
  it("says nothing when there is nothing to say", () => {
    expect(homeOfficeNotices(overlap(), RATE)).toEqual([]);
  });

  it("says so at the cap, so a bigger room is not measured for nothing", () => {
    const n = homeOfficeNotices(
      overlap({ square_feet: 400, deduction_cents: 150000 }),
      RATE,
    );
    expect(n[0]?.kind).toBe("at_cap");
    expect(n[0]?.text).toMatch(/\$1500\.00|\$1,500\.00/);
  });

  it("warns on the double count, with BOTH figures", () => {
    // AC3. Neither number looks wrong on its own, which is exactly why the
    // warning has to put them side by side.
    const n = homeOfficeNotices(
      overlap({ overlaps: true, rent_cents: 40000, rent_entries: 1 }),
      RATE,
    );
    const w = n.find((x) => x.kind === "overlap");
    expect(w?.text).toMatch(/\$600\.00/);
    expect(w?.text).toMatch(/\$400\.00/);
  });

  it("names utilities too when those are what overlap", () => {
    const n = homeOfficeNotices(
      overlap({ overlaps: true, utilities_cents: 25000, utilities_entries: 3 }),
      RATE,
    );
    expect(n.find((x) => x.kind === "overlap")?.text).toMatch(
      /\$250\.00 of utilities/,
    );
  });

  it("names both when both overlap", () => {
    const n = homeOfficeNotices(
      overlap({
        overlaps: true,
        rent_cents: 40000,
        rent_entries: 1,
        utilities_cents: 25000,
        utilities_entries: 2,
      }),
      RATE,
    );
    const text = n.find((x) => x.kind === "overlap")?.text ?? "";
    expect(text).toMatch(/rent or storage/);
    expect(text).toMatch(/utilities/);
  });

  it("REPORTS rather than accuses", () => {
    // A seller with a home office and a genuinely separate storage unit is
    // fine, and the app cannot tell that apart from double-counting.
    const text =
      homeOfficeNotices(
        overlap({ overlaps: true, rent_cents: 40000, rent_entries: 1 }),
        RATE,
      ).find((x) => x.kind === "overlap")?.text ?? "";
    expect(text).toMatch(/separate storage unit is fine/i);
    expect(text).toMatch(/Only you can tell/i);
  });

  it("tells an actual-expenses seller the figure does not apply, and stops", () => {
    const n = homeOfficeNotices(
      overlap({ method: "actual", overlaps: true, rent_entries: 1 }),
      RATE,
    );
    expect(n).toHaveLength(1);
    expect(n[0]?.kind).toBe("actual_method");
    expect(n[0]?.text).toMatch(/8829/);
  });

  it("survives a missing rate without throwing", () => {
    expect(() =>
      homeOfficeNotices(overlap({ overlaps: true, rent_entries: 1 }), null),
    ).not.toThrow();
  });
});
