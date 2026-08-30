import { describe, it, expect } from "vitest";
import {
  duePeriods,
  nextDue,
  selfEmploymentTax,
  estimateTax,
  setAsidePercent,
  type TaxRateYear,
} from "./estimated-tax";

// US-2991.

const RATES_2025: TaxRateYear = {
  tax_year: 2025,
  ss_wage_base_cents: 17610000,
  social_security_rate_bps: 1240,
  medicare_rate_bps: 290,
  se_income_factor_bps: 9235,
  addl_medicare_rate_bps: 90,
  addl_medicare_threshold: {
    single: 20000000,
    married_joint: 25000000,
    married_separate: 12500000,
    head_of_household: 20000000,
    qualifying_surviving_spouse: 20000000,
  },
  safe_harbour_high_agi_cents: 15000000,
  safe_harbour_low_bps: 10000,
  safe_harbour_high_bps: 11000,
  is_provisional: false,
  note: "2025",
};

describe("the four due dates", () => {
  it("are NOT evenly spaced, and the last one is in JANUARY of the next year", () => {
    // The mistake this exists to prevent: a seller who budgets four payments
    // inside the calendar year is short one in January.
    expect(duePeriods(2025).map((p) => p.dueOn)).toEqual([
      "2025-04-15",
      "2025-06-15",
      "2025-09-15",
      "2026-01-15",
    ]);
  });

  it("say what each one covers, because the gaps are uneven", () => {
    const p = duePeriods(2025);
    // The second covers two months and the fourth covers four.
    expect(p[1]?.covers).toBe("April and May");
    expect(p[3]?.covers).toBe("September to December");
  });

  it("splits the year's tax into four equal instalments", () => {
    // The COVERAGE is uneven; the instalments are not. Both facts are true and
    // conflating them is how the wrong amount goes at the wrong time.
    expect(duePeriods(2025).reduce((s, p) => s + p.shareBps, 0)).toBe(10000);
  });
});

describe("nextDue", () => {
  it("finds the period still ahead", () => {
    expect(nextDue(2025, "2025-05-01")?.quarter).toBe(2);
    expect(nextDue(2025, "2025-06-15")?.quarter).toBe(2);
    expect(nextDue(2025, "2025-06-16")?.quarter).toBe(3);
  });

  it("still points at January after the calendar year ends", () => {
    expect(nextDue(2025, "2025-12-20")?.quarter).toBe(4);
    expect(nextDue(2025, "2026-01-10")?.quarter).toBe(4);
  });

  it("returns null once they are all past", () => {
    expect(nextDue(2025, "2026-02-01")).toBeNull();
  });
});

describe("selfEmploymentTax", () => {
  it("applies the 92.35% factor before anything else", () => {
    // Not a rounding fudge: it is the deduction for the employer half, and
    // leaving it out overstates the bill by about 8%.
    const se = selfEmploymentTax(10000000, "single", RATES_2025);
    expect(se.netEarningsCents).toBe(9235000);
  });

  it("computes 15.3% on a modest profit", () => {
    // $40,000 profit: net earnings $36,940, SS $4,580.56, Medicare $1,071.26.
    const se = selfEmploymentTax(4000000, "single", RATES_2025);
    expect(se.netEarningsCents).toBe(3694000);
    expect(se.socialSecurityCents).toBe(458056);
    expect(se.medicareCents).toBe(107126);
    expect(se.additionalMedicareCents).toBe(0);
    expect(se.totalCents).toBe(565182);
  });

  it("caps Social Security at the wage base and lets Medicare run on", () => {
    const se = selfEmploymentTax(30000000, "single", RATES_2025);
    expect(se.cappedAtWageBase).toBe(true);
    // Capped at the wage base, not at net earnings.
    expect(se.socialSecurityCents).toBe(
      Math.round((RATES_2025.ss_wage_base_cents * 1240) / 10000),
    );
    // Medicare is on the FULL net earnings.
    expect(se.medicareCents).toBe(
      Math.round((se.netEarningsCents * 290) / 10000),
    );
  });

  it("adds the 0.9% surcharge only above the threshold", () => {
    const under = selfEmploymentTax(20000000, "single", RATES_2025);
    expect(under.additionalMedicareCents).toBe(0);
    const over = selfEmploymentTax(30000000, "single", RATES_2025);
    expect(over.additionalMedicareCents).toBeGreaterThan(0);
  });

  it("uses the filing status's own threshold", () => {
    // Married filing separately starts at half the single threshold.
    const profit = 15000000;
    const single = selfEmploymentTax(profit, "single", RATES_2025);
    const separate = selfEmploymentTax(profit, "married_separate", RATES_2025);
    expect(single.additionalMedicareCents).toBe(0);
    expect(separate.additionalMedicareCents).toBeGreaterThan(0);
  });

  it("does not halve the surcharge into the deduction", () => {
    // The extra 0.9% has no employer match, so including it in the deductible
    // half would overstate the deduction.
    const se = selfEmploymentTax(30000000, "single", RATES_2025);
    expect(se.deductibleHalfCents).toBe(
      Math.round((se.socialSecurityCents + se.medicareCents) / 2),
    );
    expect(se.deductibleHalfCents).toBeLessThan(se.totalCents / 2);
  });

  it("is zero on a loss, not negative", () => {
    const se = selfEmploymentTax(-500000, "single", RATES_2025);
    expect(se.totalCents).toBe(0);
    expect(se.deductibleHalfCents).toBe(0);
  });
});

describe("estimateTax", () => {
  const base = {
    taxYear: 2025,
    netProfitCents: 4000000,
    status: "single" as const,
    rates: RATES_2025,
    incomeTaxRateBps: 1200,
    otherHouseholdIncomeCents: null,
    lastYearTotalTaxCents: null,
    paidCents: 0,
    preferSafeHarbour: false,
  };

  it("takes the deductible SE half off before applying income tax", () => {
    // Not subtracting it overstates the bill. It is the one adjustment simple
    // enough to make without seeing the whole return.
    const e = estimateTax(base);
    const expectedBase = 4000000 - e.se.deductibleHalfCents;
    expect(e.incomeTaxCents).toBe(Math.round((expectedBase * 1200) / 10000));
  });

  it("splits into four instalments that never total less than the bill", () => {
    // Rounded UP, so a seller paying the shown instalment four times is never
    // short by a cent.
    for (const profit of [123457, 4000001, 999999]) {
      const e = estimateTax({ ...base, netProfitCents: profit });
      expect(e.perPeriodCents * 4).toBeGreaterThanOrEqual(e.totalCents);
    }
  });

  it("shows the SHORTFALL, not the ideal, once payments are recorded", () => {
    const e = estimateTax({ ...base, paidCents: 200000 });
    expect(e.shortfallCents).toBe(e.totalCents - 200000);
  });

  it("never shows a negative shortfall when overpaid", () => {
    const e = estimateTax({ ...base, paidCents: 99999999 });
    expect(e.shortfallCents).toBe(0);
  });

  it("offers the safe harbour when last year's tax is known", () => {
    const e = estimateTax({ ...base, lastYearTotalTaxCents: 500000 });
    expect(e.safeHarbourCents).toBe(500000);
    expect(e.safeHarbourRateBps).toBe(10000);
    // Offered, but not used unless asked for.
    expect(e.method).toBe("projection");
  });

  it("uses 110% above the AGI threshold", () => {
    const e = estimateTax({
      ...base,
      netProfitCents: 20000000,
      lastYearTotalTaxCents: 1000000,
    });
    expect(e.safeHarbourRateBps).toBe(11000);
    expect(e.safeHarbourCents).toBe(1100000);
  });

  it("uses the LOWER multiplier when income is unknown", () => {
    // Claiming 110% of a number we cannot justify would overstate what is owed.
    const e = estimateTax({
      ...base,
      netProfitCents: 1000,
      otherHouseholdIncomeCents: null,
      lastYearTotalTaxCents: 1000000,
    });
    expect(e.safeHarbourRateBps).toBe(10000);
  });

  it("switches to the safe harbour when asked, and only when available", () => {
    const withIt = estimateTax({
      ...base,
      lastYearTotalTaxCents: 500000,
      preferSafeHarbour: true,
    });
    expect(withIt.method).toBe("safe_harbour");
    expect(withIt.totalCents).toBe(500000);

    // Asking for it without last year's figure falls back rather than
    // producing nothing.
    const without = estimateTax({ ...base, preferSafeHarbour: true });
    expect(without.method).toBe("projection");
  });

  it("falls back to a stated default rate rather than to zero", () => {
    const e = estimateTax({ ...base, incomeTaxRateBps: null });
    expect(e.incomeTaxRateBps).toBe(1200);
    expect(e.incomeTaxCents).toBeGreaterThan(0);
  });
});

describe("the assumptions are named, because an unexplained figure is worse than none", () => {
  const base = {
    taxYear: 2025,
    netProfitCents: 4000000,
    status: "single" as const,
    rates: RATES_2025,
    incomeTaxRateBps: 1200,
    otherHouseholdIncomeCents: null,
    lastYearTotalTaxCents: null,
    paidCents: 0,
    preferSafeHarbour: false,
  };

  it("says which part is exact and which is the seller's own guess", () => {
    const a = estimateTax(base).assumptions.join(" ");
    expect(a).toMatch(/This part is exact/);
    expect(a).toMatch(/YOUR assumption, not a calculation/);
  });

  it("warns when no other household income was given", () => {
    expect(estimateTax(base).assumptions.join(" ")).toMatch(
      /your real rate is probably higher/,
    );
    expect(
      estimateTax({ ...base, otherHouseholdIncomeCents: 5000000 })
        .assumptions.join(" "),
    ).not.toMatch(/probably higher/);
  });

  it("says so when Social Security has capped out", () => {
    expect(
      estimateTax({ ...base, netProfitCents: 30000000 }).assumptions.join(" "),
    ).toMatch(/Social Security stops at/);
  });

  it("always says federal only, no state", () => {
    expect(estimateTax(base).assumptions.join(" ")).toMatch(/no state tax/);
  });

  it("flags a provisional year", () => {
    const provisional = { ...RATES_2025, is_provisional: true };
    expect(
      estimateTax({ ...base, rates: provisional }).assumptions.join(" "),
    ).toMatch(/carried forward/);
  });

  it("explains the safe harbour in terms of the penalty, not the arithmetic", () => {
    const a = estimateTax({
      ...base,
      lastYearTotalTaxCents: 500000,
      preferSafeHarbour: true,
    }).assumptions.join(" ");
    expect(a).toMatch(/no underpayment penalty/);
  });
});

describe("setAsidePercent", () => {
  it("is the headline a reseller actually acts on", () => {
    const e = estimateTax({
      taxYear: 2025,
      netProfitCents: 4000000,
      status: "single",
      rates: RATES_2025,
      incomeTaxRateBps: 1200,
      otherHouseholdIncomeCents: null,
      lastYearTotalTaxCents: null,
      paidCents: 0,
      preferSafeHarbour: false,
    });
    const pct = setAsidePercent(e);
    // Somewhere in the low-to-mid twenties for a modest profit at 12%.
    expect(pct).toBeGreaterThan(20);
    expect(pct).toBeLessThan(30);
  });

  it("is null on no profit rather than dividing by zero", () => {
    const e = estimateTax({
      taxYear: 2025,
      netProfitCents: 0,
      status: "single",
      rates: RATES_2025,
      incomeTaxRateBps: 1200,
      otherHouseholdIncomeCents: null,
      lastYearTotalTaxCents: null,
      paidCents: 0,
      preferSafeHarbour: false,
    });
    expect(setAsidePercent(e)).toBeNull();
  });
});
