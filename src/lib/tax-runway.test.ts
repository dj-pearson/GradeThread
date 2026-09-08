import { describe, it, expect } from "vitest";
import type { TaxRateYear } from "./estimated-tax";
import {
  elapsedShareBps,
  periodWindows,
  standingHeadline,
  taxRunway,
  type DatedEntry,
} from "./tax-runway";

// US-3137 — the running obligation.
//
// Every case fixes `today`. A seasonal test that passes in March and fails in
// November is worse than no test: it goes red on a day nobody changed anything
// and gets deleted rather than read.

const RATES_2026: TaxRateYear = {
  tax_year: 2026,
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
  note: "2026",
};

/**
 * The profit function the real screens pass is `buildStatement`. Here it is a
 * plain sum, because what is under test is the BUCKETING and the schedule, not
 * the chart of accounts — and a fake that re-implemented the statement would
 * only prove the fake agrees with itself.
 */
const sumProfit = (entries: DatedEntry[]) =>
  entries.reduce((s, e) => s + e.amount_cents, 0);

function profit(date: string, cents: number): DatedEntry {
  return { entry_date: date, account: "4000", amount_cents: cents };
}

function runway(opts: {
  today: string;
  entries: DatedEntry[];
  payments?: { tax_year: number; quarter: number; paid_cents: number }[];
  fiscalYearStartMonth?: number;
  lastYearTotalTaxCents?: number | null;
}) {
  return taxRunway({
    taxYear: 2026,
    today: opts.today,
    entries: opts.entries,
    profitFor: sumProfit,
    status: "single",
    rates: RATES_2026,
    incomeTaxRateBps: 1200,
    otherHouseholdIncomeCents: null,
    lastYearTotalTaxCents: opts.lastYearTotalTaxCents ?? null,
    payments: (opts.payments ?? []).map((p) => ({
      ...p,
      paid_on: null,
      note: null,
    })),
    fiscalYearStartMonth: opts.fiscalYearStartMonth ?? 1,
  });
}

describe("the period windows", () => {
  it("are the COVERAGE windows, and they are not equal", () => {
    // April to May is two months; September to December is four. This is the
    // fact that a "divide by four" tracker gets wrong.
    expect(periodWindows(2026)).toEqual([
      { from: "2026-01-01", to: "2026-04-01" },
      { from: "2026-04-01", to: "2026-06-01" },
      { from: "2026-06-01", to: "2026-09-01" },
      { from: "2026-09-01", to: "2027-01-01" },
    ]);
  });

  it("tile the whole year with no gap and no overlap", () => {
    const w = periodWindows(2026);
    for (let i = 1; i < w.length; i++) {
      expect(w[i]?.from).toBe(w[i - 1]?.to);
    }
    expect(w[0]?.from).toBe("2026-01-01");
    expect(w[w.length - 1]?.to).toBe("2027-01-01");
  });
});

describe("elapsedShareBps", () => {
  it("counts days, not months", () => {
    // 180 of 2026's 365 days have gone by the morning of 30 June.
    expect(elapsedShareBps(2026, "2026-06-30")).toBe(4932);
  });

  it("clamps outside the year rather than going negative or past 100%", () => {
    expect(elapsedShareBps(2026, "2025-12-31")).toBe(0);
    expect(elapsedShareBps(2026, "2027-06-01")).toBe(10000);
  });
});

describe("what has accrued", () => {
  it("is tax on profit ALREADY EARNED, never a projection", () => {
    const r = runway({
      today: "2026-03-31",
      entries: [profit("2026-02-01", 1_000_000)],
    });
    expect(r.netProfitToDateCents).toBe(1_000_000);
    // Self-employment tax alone on $10,000 is 15.3% of 92.35% of it.
    expect(r.accruedCents).toBeGreaterThan(0);
    // The projection is a SEPARATE field and is larger, because a quarter of
    // the year produced this. If these two were ever equal the distinction
    // this file exists for would have collapsed.
    expect(r.projectedYearEndCents).toBeGreaterThan(r.accruedCents);
  });

  it("ignores profit dated after today", () => {
    // A sale dated next month must not appear in what is owed now.
    const r = runway({
      today: "2026-03-31",
      entries: [profit("2026-02-01", 1_000_000), profit("2026-11-01", 5_000_000)],
    });
    expect(r.netProfitToDateCents).toBe(1_000_000);
  });

  it("includes profit dated TODAY", () => {
    // The window is half-open, so today has to be pulled in explicitly. Off by
    // one here hides a sale from its own seller on the day they made it.
    const r = runway({
      today: "2026-03-31",
      entries: [profit("2026-03-31", 400_000)],
    });
    expect(r.netProfitToDateCents).toBe(400_000);
  });

  it("accrues nothing on a loss", () => {
    const r = runway({
      today: "2026-06-30",
      entries: [profit("2026-02-01", -300_000)],
    });
    expect(r.accruedCents).toBe(0);
    expect(r.standing).toBe("no_profit");
  });
});

describe("what is due so far", () => {
  it("is zero before the first due date, however much has been earned", () => {
    // THE POINT. A seller who made their whole year in January is not late on
    // 1 April, and telling them they are is how the tracker loses its
    // credibility on day one.
    const r = runway({
      today: "2026-04-01",
      entries: [profit("2026-01-15", 4_000_000)],
    });
    expect(r.accruedCents).toBeGreaterThan(0);
    expect(r.dueSoFarCents).toBe(0);
    expect(r.behindByCents).toBe(0);
    expect(r.standing).toBe("on_track");
  });

  it("never asks for tax on income the seller has not earned yet", () => {
    // A Q4 seller in September: the even instalment would be three quarters of
    // the year's tax, but only the September profit exists. The target is the
    // smaller of the two, so it tracks reality.
    const r = runway({
      today: "2026-09-16",
      entries: [profit("2026-09-05", 2_000_000)],
    });
    const q3 = r.periods.find((p) => p.quarter === 3)!;
    expect(q3.targetThroughCents).toBe(q3.accruedThroughCents);
    expect(q3.targetThroughCents).toBeLessThan(
      Math.ceil((r.accruedCents * 3) / 4),
    );
  });

  it("caps the target at the even instalment for a front-loaded year", () => {
    // The mirror case. Everything was earned in January, so the accrued figure
    // through Q1 is the whole year's tax — but only a quarter of it is due in
    // April. Charging the lot would be the same error in the other direction.
    const r = runway({
      today: "2026-04-16",
      entries: [profit("2026-01-15", 4_000_000)],
    });
    const q1 = r.periods.find((p) => p.quarter === 1)!;
    expect(q1.targetThroughCents).toBe(Math.ceil(r.accruedCents / 4));
    expect(q1.targetThroughCents).toBeLessThan(q1.accruedThroughCents);
  });

  it("counts a payment against the shortfall", () => {
    const entries = [profit("2026-01-15", 4_000_000)];
    const before = runway({ today: "2026-04-16", entries });
    const after = runway({
      today: "2026-04-16",
      entries,
      payments: [
        { tax_year: 2026, quarter: 1, paid_cents: before.dueSoFarCents },
      ],
    });
    expect(before.behindByCents).toBeGreaterThan(0);
    expect(after.behindByCents).toBe(0);
    expect(after.standing).toBe("on_track");
  });

  it("ignores payments recorded against a different tax year", () => {
    // Paying last year's bill in April does not make this year's instalment
    // paid, and a tracker that netted them off would say "you are fine" to
    // somebody who is not.
    const r = runway({
      today: "2026-04-16",
      entries: [profit("2026-01-15", 4_000_000)],
      payments: [{ tax_year: 2025, quarter: 4, paid_cents: 100_000_000 }],
    });
    expect(r.paidCents).toBe(0);
    expect(r.standing).toBe("behind");
  });

  it("reads as ahead once payments pass everything accrued", () => {
    const r = runway({
      today: "2026-06-30",
      entries: [profit("2026-01-15", 1_000_000)],
      payments: [{ tax_year: 2026, quarter: 1, paid_cents: 99_999_999 }],
    });
    expect(r.standing).toBe("ahead");
    expect(r.holdBackCents).toBe(0);
  });
});

describe("the four periods", () => {
  it("bucket profit by the window it was earned in, and add up to the year", () => {
    const entries = [
      profit("2026-02-01", 100_000),
      profit("2026-05-01", 200_000),
      profit("2026-07-01", 300_000),
      profit("2026-10-01", 400_000),
    ];
    const r = runway({ today: "2026-12-31", entries });
    expect(r.periods.map((p) => p.earnedCents)).toEqual([
      100_000, 200_000, 300_000, 400_000,
    ]);
    expect(r.periods.reduce((s, p) => s + p.earnedCents, 0)).toBe(
      r.netProfitToDateCents,
    );
  });

  it("marks a past period with an unpaid target as open, not upcoming", () => {
    const r = runway({
      today: "2026-06-30",
      entries: [profit("2026-01-15", 4_000_000)],
    });
    expect(r.periods.find((p) => p.quarter === 1)?.state).toBe("open");
    expect(r.periods.find((p) => p.quarter === 4)?.state).toBe("upcoming");
  });

  it("puts the fourth due date in JANUARY of the next year", () => {
    const r = runway({ today: "2026-12-20", entries: [] });
    expect(r.periods[3]?.dueOn).toBe("2027-01-15");
    // And so on 20 December the next payment due is still that January one.
    expect(r.nextDue?.dueOn).toBe("2027-01-15");
  });
});

describe("the projection", () => {
  it("is withheld while too little of the year has run", () => {
    // Scaling one good week in January to a full year produces a five-figure
    // number built on nothing. Better to say so than to print it.
    const r = runway({
      today: "2026-01-20",
      entries: [profit("2026-01-15", 500_000)],
    });
    expect(r.projectedYearEndCents).toBeNull();
    expect(r.assumptions.join(" ")).toContain("Too little of the year");
  });

  it("names its basis whenever it shows a number", () => {
    const r = runway({
      today: "2026-06-30",
      entries: [profit("2026-02-01", 1_000_000)],
    });
    expect(r.projectedYearEndCents).not.toBeNull();
    expect(r.projectionBasis).toContain("scaled up to a full year");
  });
});

describe("the assumptions", () => {
  it("lead with the fact that the headline is not a forecast", () => {
    const r = runway({
      today: "2026-06-30",
      entries: [profit("2026-02-01", 1_000_000)],
    });
    expect(r.assumptions[0]).toContain("ALREADY made");
  });

  it("say so when the seller is not on a calendar year", () => {
    const r = runway({
      today: "2026-06-30",
      entries: [profit("2026-02-01", 1_000_000)],
      fiscalYearStartMonth: 7,
    });
    expect(r.assumptions.join(" ")).toContain("does not start in January");
  });

  it("carry the income-tax-rate disclosure through from the estimate", () => {
    // The rate is the seller's assumption, not our calculation, and the
    // running figure inherits that caveat rather than quietly dropping it.
    const r = runway({
      today: "2026-06-30",
      entries: [profit("2026-02-01", 1_000_000)],
    });
    expect(r.assumptions.join(" ")).toContain("YOUR assumption");
  });
});

describe("standingHeadline", () => {
  it("has a sentence for every standing", () => {
    const cases: { today: string; entries: DatedEntry[] }[] = [
      { today: "2026-06-30", entries: [] },
      { today: "2026-04-16", entries: [profit("2026-01-15", 4_000_000)] },
      { today: "2026-04-01", entries: [profit("2026-01-15", 4_000_000)] },
    ];
    for (const c of cases) {
      expect(standingHeadline(runway(c)).length).toBeGreaterThan(0);
    }
  });

  it("never tells the seller what to do", () => {
    // The whole module states facts about their own books. "You should pay X"
    // is advice and is the line this product does not cross.
    const r = runway({
      today: "2026-04-16",
      entries: [profit("2026-01-15", 4_000_000)],
    });
    expect(standingHeadline(r)).not.toMatch(/you should|we recommend|must pay/i);
  });
});
