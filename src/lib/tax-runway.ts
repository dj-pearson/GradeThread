import type { FilingStatus } from "@/lib/tax-profile";
import {
  duePeriods,
  estimateTax,
  type DuePeriod,
  type EstimatedTaxPayment,
  type TaxEstimate,
  type TaxRateYear,
} from "@/lib/estimated-tax";

// US-3137 — the running tax obligation.
//
// THE PROBLEM THIS FIXES. `estimateTax` answers "what will I owe for the year",
// and every screen fed it the profit earned SO FAR. In March that produced a
// tiny number and in December a large one, from the same seller having the same
// year, and neither answered the question a reseller actually asks in June: am
// I behind? A figure that only becomes true in April is a figure nobody can act
// on while there is still time to act.
//
// SO THERE ARE THREE NUMBERS HERE AND THEY ARE DELIBERATELY DIFFERENT:
//
//   ACCRUED    - tax on the profit ALREADY EARNED. No projection, no
//                annualising. If the seller stopped trading today this is the
//                bill. It is the only one of the three that cannot be wrong
//                because of an assumption, so it leads.
//   DUE SO FAR - the share of that which the instalment schedule says should
//                already have been PAID. Tax on December profit is not late in
//                June, and a tracker that says otherwise trains people to
//                ignore it.
//   PROJECTED  - accrued, scaled to a full year by how much of the year has
//                run. Useful for planning and wrong the moment the seller has a
//                good month. Always shown WITH its basis, never on its own.
//
// PROFIT IS BUCKETED INTO THE FOUR IRS PERIODS, not into quarters. They are not
// the same thing: the second period covers two months, the fourth covers four,
// and the fourth payment is due in JANUARY. Dividing the year by four puts the
// money in the wrong place at the wrong time, which is the most common way a
// first-year reseller takes a penalty on a year they had the cash for.
//
// NOTHING HERE IS STORED. Every figure is derived from the ledger, the tax
// profile and the payments the seller already recorded. There is no new table,
// no new column, and nothing about the seller that was not already in the books.

/** One IRS instalment period, with what actually happened inside it. */
export interface RunwayPeriod {
  quarter: number;
  covers: string;
  dueOn: string;
  /** Half-open window the period's income falls in: [from, to). */
  from: string;
  to: string;
  /** Profit earned inside this window. Can be negative in a bad period. */
  earnedCents: number;
  /** Tax accrued on everything earned up to the END of this window. */
  accruedThroughCents: number;
  /** What the schedule wants paid by this due date, cumulatively. */
  targetThroughCents: number;
  /** Recorded payments for this quarter alone. */
  paidCents: number;
  /** Recorded payments through this quarter, cumulatively. */
  paidThroughCents: number;
  /** targetThroughCents less paidThroughCents, floored at zero. */
  shortfallCents: number;
  state: "settled" | "short" | "open" | "upcoming";
}

export type RunwayStanding = "ahead" | "on_track" | "behind" | "no_profit";

export interface TaxRunway {
  taxYear: number;
  today: string;
  /** Tax on profit already earned. The headline. */
  accruedCents: number;
  /** Of the accrued figure, what the schedule says is already payable. */
  dueSoFarCents: number;
  paidCents: number;
  /** dueSoFarCents less paidCents, floored at zero. What to send now. */
  behindByCents: number;
  /** accruedCents less paidCents, floored at zero. What to be holding. */
  holdBackCents: number;
  standing: RunwayStanding;
  /** Accrued, scaled to a full year. Null before there is enough year to scale. */
  projectedYearEndCents: number | null;
  projectionBasis: string | null;
  /** Share of profit the accrued figure works out to, in basis points. */
  setAsideRateBps: number | null;
  netProfitToDateCents: number;
  nextDue: DuePeriod | null;
  /** What to have paid by the next due date, less what is already paid. */
  dueByNextDateCents: number;
  periods: RunwayPeriod[];
  /** The full-year estimate, for the screens that still want one. */
  estimate: TaxEstimate;
  assumptions: string[];
}

/** A ledger entry reduced to the three things this file needs. */
export interface DatedEntry {
  entry_date: string;
  account: string;
  amount_cents: number;
}

/** Profit for a half-open window, from a caller-supplied statement builder. */
export type ProfitForWindow = (entries: DatedEntry[]) => number;

/**
 * The four period windows for a tax year.
 *
 * These are the COVERAGE windows, which is what income has to be bucketed by.
 * They are not the due dates and they are not equal: April to May is two months.
 */
export function periodWindows(taxYear: number): { from: string; to: string }[] {
  return [
    { from: taxYear + "-01-01", to: taxYear + "-04-01" },
    { from: taxYear + "-04-01", to: taxYear + "-06-01" },
    { from: taxYear + "-06-01", to: taxYear + "-09-01" },
    { from: taxYear + "-09-01", to: taxYear + 1 + "-01-01" },
  ];
}

/**
 * How far through the tax year `today` is, in basis points.
 *
 * Day count, not month count. A projection made on 30 June that assumed half
 * the year had run would be out by a day and a half, which nobody would notice
 * and which makes every downstream figure slightly unfalsifiable.
 */
export function elapsedShareBps(taxYear: number, today: string): number {
  const start = Date.UTC(taxYear, 0, 1);
  const end = Date.UTC(taxYear + 1, 0, 1);
  const now = Date.parse(today + "T00:00:00Z");
  if (Number.isNaN(now)) return 0;
  if (now <= start) return 0;
  if (now >= end) return 10000;
  return Math.round(((now - start) / (end - start)) * 10000);
}

/** Tax on one profit figure, using the seller's own assumptions. */
function taxOn(
  profitCents: number,
  input: {
    taxYear: number;
    status: FilingStatus;
    rates: TaxRateYear;
    incomeTaxRateBps: number | null;
    otherHouseholdIncomeCents: number | null;
  },
): TaxEstimate {
  return estimateTax({
    taxYear: input.taxYear,
    netProfitCents: profitCents,
    status: input.status,
    rates: input.rates,
    incomeTaxRateBps: input.incomeTaxRateBps,
    otherHouseholdIncomeCents: input.otherHouseholdIncomeCents,
    // The safe harbour is a full-year target and says nothing about what has
    // accrued by June, so the running figure never uses it. It stays available
    // on `estimate` for the screens that offer it as an alternative.
    lastYearTotalTaxCents: null,
    paidCents: 0,
    preferSafeHarbour: false,
  });
}

export interface RunwayInput {
  taxYear: number;
  /** ISO date. Injected rather than read, so the tests are not seasonal. */
  today: string;
  /** Every ledger entry for the tax year, with its date. */
  entries: DatedEntry[];
  /** Turns a window's entries into a net profit figure. */
  profitFor: ProfitForWindow;
  status: FilingStatus;
  rates: TaxRateYear;
  incomeTaxRateBps: number | null;
  otherHouseholdIncomeCents: number | null;
  lastYearTotalTaxCents: number | null;
  payments: EstimatedTaxPayment[];
  /** 1-12. Anything but 1 makes the instalment dates an approximation. */
  fiscalYearStartMonth: number;
}

/**
 * The running obligation.
 *
 * PURE. It fetches nothing and stores nothing; the caller supplies the ledger
 * rows and the profit function, which is how the P&L, the packet and this all
 * stay one number (US-2984's invariant).
 */
export function taxRunway(input: RunwayInput): TaxRunway {
  const { taxYear, today, entries, profitFor, payments } = input;
  const windows = periodWindows(taxYear);
  const dues = duePeriods(taxYear);
  const yearStart = taxYear + "-01-01";

  const inWindow = (from: string, to: string) =>
    entries.filter((e) => e.entry_date >= from && e.entry_date < to);

  // Profit through the end of each window, and inside each window. Both are
  // computed from the SAME entries through the SAME profit function, so the
  // four periods always add up to the year and no screen can disagree.
  const throughProfit: number[] = [];
  const insideProfit: number[] = [];
  for (const w of windows) {
    throughProfit.push(profitFor(inWindow(yearStart, w.to)));
    insideProfit.push(profitFor(inWindow(w.from, w.to)));
  }

  const netProfitToDateCents = profitFor(inWindow(yearStart, nextDay(today)));

  const accrued = taxOn(Math.max(0, netProfitToDateCents), input);
  const accruedCents = accrued.totalCents;

  const paidByQuarter = new Map<number, number>();
  for (const p of payments) {
    if (p.tax_year !== taxYear) continue;
    paidByQuarter.set(
      p.quarter,
      (paidByQuarter.get(p.quarter) ?? 0) + p.paid_cents,
    );
  }
  const paidCents = [...paidByQuarter.values()].reduce((s, c) => s + c, 0);

  let paidRunning = 0;
  const periods: RunwayPeriod[] = windows.map((w, i) => {
    const due = dues[i]!;
    const accruedThroughCents = taxOn(
      Math.max(0, throughProfit[i] ?? 0),
      input,
    ).totalCents;

    // THE TARGET IS THE SMALLER OF TWO THINGS, and that is the whole fairness
    // of it. The even instalment is (i+1)/4 of the year's tax, which is what
    // the schedule asks of a steady earner. The accrued figure is what THIS
    // seller has actually earned by then. A reseller whose year happens in
    // Q4 should not read "you are behind" in April on income that does not
    // exist yet; a reseller who front-loads should not be told they are fine
    // when they have already earned the whole year's profit.
    const evenInstalment = Math.ceil((accruedCents * (i + 1)) / 4);
    const targetThroughCents = Math.min(evenInstalment, accruedThroughCents);

    const paidThis = paidByQuarter.get(due.quarter) ?? 0;
    paidRunning += paidThis;
    const shortfallCents = Math.max(0, targetThroughCents - paidRunning);

    const elapsed = due.dueOn <= today;
    const state: RunwayPeriod["state"] = !elapsed
      ? paidThis > 0
        ? "settled"
        : "upcoming"
      : shortfallCents === 0
        ? "settled"
        : paidThis > 0
          ? "short"
          : "open";

    return {
      quarter: due.quarter,
      covers: due.covers,
      dueOn: due.dueOn,
      from: w.from,
      to: w.to,
      earnedCents: insideProfit[i] ?? 0,
      accruedThroughCents,
      targetThroughCents,
      paidCents: paidThis,
      paidThroughCents: paidRunning,
      shortfallCents,
      state,
    };
  });

  // What the schedule says should already be paid: the target of the LAST
  // period whose due date has passed. Before 15 April nothing is late, however
  // much has been earned.
  const elapsedPeriods = periods.filter((p) => p.dueOn <= today);
  const dueSoFarCents =
    elapsedPeriods.length > 0
      ? (elapsedPeriods[elapsedPeriods.length - 1]?.targetThroughCents ?? 0)
      : 0;

  const behindByCents = Math.max(0, dueSoFarCents - paidCents);
  const holdBackCents = Math.max(0, accruedCents - paidCents);

  const next = dues.find((d) => d.dueOn >= today) ?? null;
  const nextPeriod = next
    ? periods.find((p) => p.quarter === next.quarter)
    : null;
  const dueByNextDateCents = nextPeriod
    ? Math.max(0, nextPeriod.targetThroughCents - paidCents)
    : 0;

  const elapsedBps = elapsedShareBps(taxYear, today);
  // Under a month of data annualises to nonsense: one good week in January
  // becomes a five-figure projection. Below 8% of the year it is withheld and
  // the screen says why, rather than showing a number nobody should use.
  const canProject = elapsedBps >= 800 && netProfitToDateCents > 0;
  const projectedProfit = canProject
    ? Math.round((netProfitToDateCents * 10000) / elapsedBps)
    : null;
  const projectedYearEndCents =
    projectedProfit == null ? null : taxOn(projectedProfit, input).totalCents;

  const standing: RunwayStanding =
    netProfitToDateCents <= 0
      ? "no_profit"
      : behindByCents === 0
        ? paidCents >= accruedCents
          ? "ahead"
          : "on_track"
        : "behind";

  const assumptions = [...accrued.assumptions];
  assumptions.unshift(
    "This is tax on the profit you have ALREADY made this year. It is not a forecast.",
  );
  if (input.fiscalYearStartMonth !== 1) {
    // Said plainly rather than silently applied. A fiscal-year filer's
    // instalment dates shift with their year end, and printing calendar dates
    // for them without saying so is how a payment goes out in the wrong month.
    assumptions.push(
      "Your books run on a fiscal year that does not start in January, but the estimated-tax dates here are the standard calendar ones. Check your own due dates with your preparer.",
    );
  }
  if (projectedYearEndCents == null && netProfitToDateCents > 0) {
    assumptions.push(
      "Too little of the year has run to project a year-end figure from it yet.",
    );
  }

  return {
    taxYear,
    today,
    accruedCents,
    dueSoFarCents,
    paidCents,
    behindByCents,
    holdBackCents,
    standing,
    projectedYearEndCents,
    projectionBasis:
      projectedYearEndCents == null
        ? null
        : "Your profit so far, scaled up to a full year (" +
          (elapsedBps / 100).toFixed(0) +
          "% of " +
          taxYear +
          " has run). One good month changes this.",
    setAsideRateBps:
      netProfitToDateCents > 0
        ? Math.round((accruedCents / netProfitToDateCents) * 10000)
        : null,
    netProfitToDateCents,
    nextDue: next,
    dueByNextDateCents,
    periods,
    estimate: estimateTax({
      taxYear,
      netProfitCents: projectedProfit ?? netProfitToDateCents,
      status: input.status,
      rates: input.rates,
      incomeTaxRateBps: input.incomeTaxRateBps,
      otherHouseholdIncomeCents: input.otherHouseholdIncomeCents,
      lastYearTotalTaxCents: input.lastYearTotalTaxCents,
      paidCents,
      preferSafeHarbour: false,
    }),
    assumptions,
  };
}

/** The day after an ISO date, so a [from, to) window can include today. */
function nextDay(iso: string): string {
  const t = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(t)) return iso;
  return new Date(t + 86_400_000).toISOString().slice(0, 10);
}

/** One sentence naming where the seller stands. Never advice. */
export function standingHeadline(r: TaxRunway): string {
  switch (r.standing) {
    case "no_profit":
      return "No profit yet in " + r.taxYear + ", so nothing has accrued.";
    case "ahead":
      return "You have paid more than has accrued so far. Nothing is owed today.";
    case "on_track":
      return "Nothing is late. Keep holding back what has accrued and you stay level.";
    case "behind":
      return "The instalment schedule wanted more by now than has been paid.";
  }
}
