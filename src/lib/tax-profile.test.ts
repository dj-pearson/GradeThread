import { describe, it, expect } from "vitest";
import {
  fiscalYearStart,
  fiscalYearEnd,
  fiscalYearLabel,
  fiscalQuarterStart,
  periodStart,
  periodLabel,
  TAX_PROFILE_DEFAULTS,
  ENTITY_TYPES,
  ENTITY_TYPE_LABELS,
  ENTITY_TYPE_HELP,
  FILING_STATUSES,
  FILING_STATUS_LABELS,
  US_STATES,
  centsToDollarInput,
  dollarInputToCents,
} from "./tax-profile";

// US-2982. The whole reason these are pure functions is that the bug they
// replace was invisible: finances.tsx assumed a January year start and showed
// the wrong twelve months to anyone else, with no error and no tell.

describe("fiscalYearStart", () => {
  it("is the calendar year for a January start", () => {
    const d = fiscalYearStart(new Date(2026, 7, 15), 1);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });

  it("looks back a year when the date is before the start month", () => {
    // July year start, and it is March. That March belongs to the year that
    // began LAST July.
    const d = fiscalYearStart(new Date(2026, 2, 10), 7);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(6);
  });

  it("stays in the current year on the first day of the start month", () => {
    const d = fiscalYearStart(new Date(2026, 6, 1), 7);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
  });

  it("is local midnight, not a UTC instant", () => {
    // The timezone trap this whole module exists to avoid: building the
    // boundary with Date.UTC would land on the previous day for anyone west of
    // Greenwich, which is US-2339's Android date bug in another costume.
    const d = fiscalYearStart(new Date(2026, 6, 20), 7);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it("clamps a nonsense start month rather than producing a nonsense date", () => {
    expect(fiscalYearStart(new Date(2026, 5, 1), 0).getMonth()).toBe(0);
    expect(fiscalYearStart(new Date(2026, 5, 1), 13).getMonth()).toBe(11);
    expect(fiscalYearStart(new Date(2026, 5, 1), NaN).getMonth()).toBe(0);
  });
});

describe("fiscalYearEnd", () => {
  it("is exactly twelve months after the start", () => {
    for (const month of [1, 4, 7, 10, 12]) {
      const on = new Date(2026, 5, 15);
      const start = fiscalYearStart(on, month);
      const end = fiscalYearEnd(on, month);
      expect(end.getMonth()).toBe(start.getMonth());
      expect(end.getFullYear()).toBe(start.getFullYear() + 1);
    }
  });

  it("is half-open: the end instant is not inside the year", () => {
    const on = new Date(2026, 5, 15);
    const end = fiscalYearEnd(on, 1);
    expect(fiscalYearStart(end, 1).getFullYear()).toBe(2027);
  });
});

describe("fiscalYearLabel", () => {
  it("names a calendar year plainly", () => {
    expect(fiscalYearLabel(new Date(2026, 7, 1), 1)).toBe("2026");
  });

  it("spans two years when the year does not start in January", () => {
    // Calling this "2026" when it ends in June 2027 is how a seller files the
    // wrong twelve months.
    expect(fiscalYearLabel(new Date(2026, 7, 1), 7)).toBe("2026-27");
    expect(fiscalYearLabel(new Date(2026, 2, 1), 7)).toBe("2025-26");
  });

  it("pads the second year across a century boundary", () => {
    expect(fiscalYearLabel(new Date(2099, 7, 1), 7)).toBe("2099-00");
  });
});

describe("fiscalQuarterStart", () => {
  it("runs from January for a calendar year", () => {
    expect(fiscalQuarterStart(new Date(2026, 4, 20), 1).getMonth()).toBe(3);
    expect(fiscalQuarterStart(new Date(2026, 0, 1), 1).getMonth()).toBe(0);
    expect(fiscalQuarterStart(new Date(2026, 11, 31), 1).getMonth()).toBe(9);
  });

  it("runs from the fiscal year start, not from January", () => {
    // July year start: Q1 is Jul-Sep. August is in Q1, October is in Q2.
    expect(fiscalQuarterStart(new Date(2026, 7, 5), 7).getMonth()).toBe(6);
    expect(fiscalQuarterStart(new Date(2026, 9, 5), 7).getMonth()).toBe(9);
  });

  it("carries into the next calendar year without slipping", () => {
    // February on a July year start is the third quarter of that fiscal year,
    // which began in January.
    const q = fiscalQuarterStart(new Date(2027, 1, 14), 7);
    expect(q.getFullYear()).toBe(2027);
    expect(q.getMonth()).toBe(0);
  });
});

describe("periodStart", () => {
  const now = new Date(2026, 2, 15, 13, 30);

  it("returns null for all time", () => {
    expect(periodStart("all_time", 1, now)).toBeNull();
  });

  it("this_month ignores the fiscal year, because a month is a month", () => {
    const a = periodStart("this_month", 1, now);
    const b = periodStart("this_month", 7, now);
    expect(a?.getTime()).toBe(b?.getTime());
    expect(a?.getMonth()).toBe(2);
    expect(a?.getDate()).toBe(1);
  });

  it("last_30 counts back thirty days from the reference instant", () => {
    const d = periodStart("last_30", 1, now);
    expect(d).not.toBeNull();
    const days = (now.getTime() - (d as Date).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it("this_year differs between a calendar and a fiscal seller", () => {
    expect(periodStart("this_year", 1, now)?.getFullYear()).toBe(2026);
    expect(periodStart("this_year", 7, now)?.getFullYear()).toBe(2025);
  });
});

describe("periodLabel", () => {
  const now = new Date(2026, 7, 1);

  it("stays plain on a calendar year", () => {
    expect(periodLabel("this_year", 1, now)).toBe("This year");
    expect(periodLabel("this_quarter", 1, now)).toBe("This quarter");
  });

  it("says which tax year it means when the year is not the calendar one", () => {
    expect(periodLabel("this_year", 7, now)).toBe("Tax year 2026-27");
    expect(periodLabel("this_quarter", 7, now)).toBe("This quarter (tax year)");
  });
});

describe("defaults and label coverage", () => {
  it("defaults to the case that covers most resellers", () => {
    expect(TAX_PROFILE_DEFAULTS.entity_type).toBe("sole_prop");
    expect(TAX_PROFILE_DEFAULTS.accounting_method).toBe("cash");
    expect(TAX_PROFILE_DEFAULTS.fiscal_year_start_month).toBe(1);
  });

  it("never carries an EIN field at all", () => {
    expect(Object.keys(TAX_PROFILE_DEFAULTS)).not.toContain("ein");
    expect(TAX_PROFILE_DEFAULTS).toHaveProperty("has_ein", false);
  });

  it("every entity type has a label and a plain-English explanation", () => {
    for (const t of ENTITY_TYPES) {
      expect(ENTITY_TYPE_LABELS[t]).toBeTruthy();
      expect(ENTITY_TYPE_HELP[t].length).toBeGreaterThan(20);
    }
  });

  it("every filing status has a label", () => {
    for (const s of FILING_STATUSES) expect(FILING_STATUS_LABELS[s]).toBeTruthy();
  });

  it("the state list is the 50 states plus DC, all two upper-case letters", () => {
    expect(US_STATES).toHaveLength(51);
    expect(new Set(US_STATES).size).toBe(51);
    for (const s of US_STATES) expect(s).toMatch(/^[A-Z]{2}$/);
  });
});

describe("money at the form boundary", () => {
  it("round-trips a plain amount", () => {
    expect(dollarInputToCents("1234.56")).toBe(123456);
    expect(centsToDollarInput(123456)).toBe("1234.56");
  });

  it("accepts what people actually type", () => {
    expect(dollarInputToCents("$1,200")).toBe(120000);
    expect(dollarInputToCents(" 42 ")).toBe(4200);
    expect(dollarInputToCents("0")).toBe(0);
  });

  it("returns null for blank and for nonsense, never zero", () => {
    // Zero is a real answer. Turning a typo into it would silently change the
    // seller's estimated tax.
    expect(dollarInputToCents("")).toBeNull();
    expect(dollarInputToCents("   ")).toBeNull();
    expect(dollarInputToCents("abc")).toBeNull();
    expect(dollarInputToCents("-50")).toBeNull();
  });

  it("rounds to the cent rather than carrying a float", () => {
    expect(dollarInputToCents("0.005")).toBe(1);
    expect(dollarInputToCents("19.999")).toBe(2000);
    expect(Number.isInteger(dollarInputToCents("8.07") as number)).toBe(true);
  });

  it("shows an empty field for an unset amount", () => {
    expect(centsToDollarInput(null)).toBe("");
    expect(centsToDollarInput(0)).toBe("0.00");
  });
});
