import { supabase } from "@/lib/supabase";
import type { FilingStatus } from "@/lib/tax-profile";

// US-2991 — quarterly estimated tax.
//
// THE SPLIT BETWEEN WHAT IS COMPUTED AND WHAT IS ASSUMED IS THE WHOLE DESIGN.
//
//   SELF-EMPLOYMENT TAX is mechanical, so it is computed exactly: 15.3% on
//   92.35% of net profit, Social Security capped at the year's wage base,
//   Medicare uncapped, plus the 0.9% surcharge above a threshold.
//
//   INCOME TAX IS NOT COMPUTED FROM BRACKETS. It depends on the seller's whole
//   return -- a spouse's wages, a W-2 job, other deductions, credits, state tax
//   -- none of which this app sees. A bracket table would produce a confident
//   number built on inputs we do not have. The seller picks a rate; the screen
//   names it as their assumption.
//
//   THE SAFE HARBOUR needs no projection at all. Pay 100% of last year's tax
//   (110% above an AGI threshold) and the underpayment penalty does not apply
//   however this year turns out. It is the more reliable target when the seller
//   knows last year's figure, and the screen offers it beside the estimate.
//
// Estimated payments are PERSONAL and never reach the ledger. Deducting them
// would understate the seller's own profit.

export interface TaxRateYear {
  tax_year: number;
  ss_wage_base_cents: number;
  social_security_rate_bps: number;
  medicare_rate_bps: number;
  se_income_factor_bps: number;
  addl_medicare_rate_bps: number;
  addl_medicare_threshold: Record<string, number>;
  safe_harbour_high_agi_cents: number;
  safe_harbour_low_bps: number;
  safe_harbour_high_bps: number;
  is_provisional: boolean;
  note: string;
}

export interface EstimatedTaxPayment {
  id?: string;
  tax_year: number;
  quarter: number;
  paid_cents: number;
  paid_on: string | null;
  note: string | null;
}

/** The four periods. Deliberately not "quarters": they are not even. */
export interface DuePeriod {
  quarter: number;
  /** What the period covers, in the seller's words. */
  covers: string;
  /** ISO date the payment is due. */
  dueOn: string;
  /** Share of the year's total this period carries, in basis points. */
  shareBps: number;
}

/**
 * The four due dates for a tax year.
 *
 * THEY ARE NOT EVENLY SPACED, and that is the thing sellers get wrong: the
 * second period covers two months, the fourth covers four, and the last one
 * falls in JANUARY OF THE NEXT YEAR. Calling them quarters and dividing by four
 * puts the money in the wrong place at the wrong time.
 *
 * The shares are equal at 2500 bps each even though the periods are not equal
 * lengths, because the IRS instalments are equal quarters of the year's tax.
 * The uneven COVERAGE only matters for when it is due.
 */
export function duePeriods(taxYear: number): DuePeriod[] {
  return [
    {
      quarter: 1,
      covers: "January to March",
      dueOn: `${taxYear}-04-15`,
      shareBps: 2500,
    },
    {
      quarter: 2,
      covers: "April and May",
      dueOn: `${taxYear}-06-15`,
      shareBps: 2500,
    },
    {
      quarter: 3,
      covers: "June to August",
      dueOn: `${taxYear}-09-15`,
      shareBps: 2500,
    },
    {
      quarter: 4,
      covers: "September to December",
      // JANUARY OF THE FOLLOWING YEAR. A seller who budgets four payments
      // inside the calendar year is short one in January.
      dueOn: `${taxYear + 1}-01-15`,
      shareBps: 2500,
    },
  ];
}

/** The next period not yet past, or null once the year is done. */
export function nextDue(
  taxYear: number,
  today: string,
): DuePeriod | null {
  return duePeriods(taxYear).find((p) => p.dueOn >= today) ?? null;
}

export interface SelfEmploymentTax {
  /** Net profit times the 92.35% factor. */
  netEarningsCents: number;
  socialSecurityCents: number;
  medicareCents: number;
  additionalMedicareCents: number;
  totalCents: number;
  /** True when the Social Security half hit the wage base. */
  cappedAtWageBase: boolean;
  /** Half of the SE tax, which is deductible against income tax. */
  deductibleHalfCents: number;
}

/**
 * Self-employment tax, computed exactly.
 *
 * The 92.35% factor is not a rounding fudge: it is the deduction for the
 * employer half of the tax, and leaving it out overstates the bill by about 8%.
 *
 * Social Security stops at the wage base. Medicare does not, and the extra 0.9%
 * above the threshold has no employer match, which is why it is a separate
 * line rather than folded into the Medicare rate.
 */
export function selfEmploymentTax(
  netProfitCents: number,
  status: FilingStatus,
  rates: TaxRateYear,
): SelfEmploymentTax {
  if (netProfitCents <= 0) {
    return {
      netEarningsCents: 0,
      socialSecurityCents: 0,
      medicareCents: 0,
      additionalMedicareCents: 0,
      totalCents: 0,
      cappedAtWageBase: false,
      deductibleHalfCents: 0,
    };
  }

  const netEarningsCents = Math.round(
    (netProfitCents * rates.se_income_factor_bps) / 10000,
  );

  const ssBase = Math.min(netEarningsCents, rates.ss_wage_base_cents);
  const socialSecurityCents = Math.round(
    (ssBase * rates.social_security_rate_bps) / 10000,
  );
  const medicareCents = Math.round(
    (netEarningsCents * rates.medicare_rate_bps) / 10000,
  );

  const threshold =
    rates.addl_medicare_threshold[status] ??
    rates.addl_medicare_threshold["single"] ??
    Number.MAX_SAFE_INTEGER;
  const over = Math.max(0, netEarningsCents - threshold);
  const additionalMedicareCents = Math.round(
    (over * rates.addl_medicare_rate_bps) / 10000,
  );

  const totalCents =
    socialSecurityCents + medicareCents + additionalMedicareCents;

  return {
    netEarningsCents,
    socialSecurityCents,
    medicareCents,
    additionalMedicareCents,
    totalCents,
    cappedAtWageBase: netEarningsCents > rates.ss_wage_base_cents,
    // The surcharge has no employer half, so it is not halved. Including it
    // would overstate the deduction.
    deductibleHalfCents: Math.round(
      (socialSecurityCents + medicareCents) / 2,
    ),
  };
}

export type EstimateMethod = "projection" | "safe_harbour";

export interface TaxEstimate {
  method: EstimateMethod;
  netProfitCents: number;
  se: SelfEmploymentTax;
  /** The seller's chosen rate, applied to profit less the deductible SE half. */
  incomeTaxCents: number;
  incomeTaxRateBps: number;
  totalCents: number;
  /** Per-period instalment, and what remains after what has been paid. */
  perPeriodCents: number;
  paidCents: number;
  shortfallCents: number;
  /** Set when the safe harbour is available but not selected, or vice versa. */
  safeHarbourCents: number | null;
  safeHarbourRateBps: number | null;
  assumptions: string[];
}

const DEFAULT_INCOME_TAX_BPS = 1200;

/**
 * The whole picture for one tax year.
 *
 * `assumptions` is not decoration. AC4 requires the screen to name what the
 * number rests on, because an unexplained figure here is worse than none: a
 * seller who cannot see the assumptions cannot tell whether it applies to them,
 * and will either over-save all year or discover in April that it did not.
 */
export function estimateTax(input: {
  taxYear: number;
  netProfitCents: number;
  status: FilingStatus;
  rates: TaxRateYear;
  incomeTaxRateBps: number | null;
  otherHouseholdIncomeCents: number | null;
  lastYearTotalTaxCents: number | null;
  paidCents: number;
  preferSafeHarbour: boolean;
}): TaxEstimate {
  const {
    netProfitCents,
    status,
    rates,
    incomeTaxRateBps,
    otherHouseholdIncomeCents,
    lastYearTotalTaxCents,
    paidCents,
    preferSafeHarbour,
  } = input;

  const se = selfEmploymentTax(Math.max(0, netProfitCents), status, rates);
  const rateBps = incomeTaxRateBps ?? DEFAULT_INCOME_TAX_BPS;

  // Income tax applies to profit LESS the deductible half of the SE tax. Not
  // subtracting it overstates the bill; it is the one adjustment simple enough
  // to make without seeing the whole return.
  const incomeBase = Math.max(0, netProfitCents - se.deductibleHalfCents);
  const incomeTaxCents = Math.round((incomeBase * rateBps) / 10000);

  const projectionTotal = se.totalCents + incomeTaxCents;

  // Safe harbour: 100% of last year's tax, or 110% if last year's income was
  // above the threshold. Household income is the closest thing this app has to
  // an AGI, and where it is unknown the LOWER multiplier is used -- claiming
  // 110% of a number we cannot justify would overstate what is owed.
  let safeHarbourCents: number | null = null;
  let safeHarbourRateBps: number | null = null;
  if (lastYearTotalTaxCents != null && lastYearTotalTaxCents > 0) {
    const roughAgi = netProfitCents + (otherHouseholdIncomeCents ?? 0);
    safeHarbourRateBps =
      roughAgi > rates.safe_harbour_high_agi_cents
        ? rates.safe_harbour_high_bps
        : rates.safe_harbour_low_bps;
    safeHarbourCents = Math.round(
      (lastYearTotalTaxCents * safeHarbourRateBps) / 10000,
    );
  }

  const useSafeHarbour = preferSafeHarbour && safeHarbourCents != null;
  const method: EstimateMethod = useSafeHarbour ? "safe_harbour" : "projection";
  const totalCents = useSafeHarbour
    ? (safeHarbourCents as number)
    : projectionTotal;

  const assumptions: string[] = [];
  if (useSafeHarbour) {
    assumptions.push(
      `Based on last year's total tax of $${(
        (lastYearTotalTaxCents as number) / 100
      ).toFixed(2)}, at ${((safeHarbourRateBps as number) / 100).toFixed(0)}%. Paying this much means no underpayment penalty, whatever this year turns out to be.`,
    );
  } else {
    assumptions.push(
      `Self-employment tax of ${((rates.social_security_rate_bps + rates.medicare_rate_bps) / 100).toFixed(1)}% on ${(rates.se_income_factor_bps / 100).toFixed(2)}% of your profit. This part is exact.`,
    );
    assumptions.push(
      `Income tax at ${(rateBps / 100).toFixed(0)}%, which is YOUR assumption, not a calculation. We cannot work out your real rate without your whole return.`,
    );
    if (otherHouseholdIncomeCents == null) {
      assumptions.push(
        "No other household income entered. If you or a partner also earn a wage, your real rate is probably higher than the one above.",
      );
    }
    if (se.cappedAtWageBase) {
      assumptions.push(
        `Social Security stops at $${(rates.ss_wage_base_cents / 100).toLocaleString("en-US")} of earnings, which you have passed. Medicare keeps going.`,
      );
    }
  }
  assumptions.push(
    `Filing as ${status.replace(/_/g, " ")}. Federal only, no state tax.`,
  );
  if (rates.is_provisional) {
    assumptions.push(
      `The ${input.taxYear} figures are carried forward from the year before, because the official ones were not published when this shipped. Check them before you pay.`,
    );
  }

  return {
    method,
    netProfitCents,
    se,
    incomeTaxCents,
    incomeTaxRateBps: rateBps,
    totalCents,
    // Rounded UP, so four instalments never come to less than the total.
    perPeriodCents: Math.ceil(totalCents / 4),
    paidCents,
    shortfallCents: Math.max(0, totalCents - paidCents),
    safeHarbourCents,
    safeHarbourRateBps,
    assumptions,
  };
}

/** The share of profit this works out to, for the "set aside X%" headline. */
export function setAsidePercent(estimate: TaxEstimate): number | null {
  if (estimate.netProfitCents <= 0) return null;
  return (estimate.totalCents / estimate.netProfitCents) * 100;
}

// ── Reads and writes ───────────────────────────────────────────────────────

export async function fetchTaxRateYear(
  taxYear: number,
): Promise<TaxRateYear | null> {
  const { data, error } = await supabase
    .from("tax_rate_years")
    .select("*")
    .eq("tax_year", taxYear)
    .maybeSingle();
  if (error) throw error;
  return (data as TaxRateYear | null) ?? null;
}

export async function fetchPayments(
  taxYear: number,
): Promise<EstimatedTaxPayment[]> {
  const { data, error } = await supabase
    .from("estimated_tax_payments")
    .select("id, tax_year, quarter, paid_cents, paid_on, note")
    .eq("tax_year", taxYear)
    .order("quarter");
  if (error) throw error;
  return (data ?? []) as EstimatedTaxPayment[];
}

export async function savePayment(
  userId: string,
  payment: EstimatedTaxPayment,
): Promise<void> {
  const { error } = await supabase
    .from("estimated_tax_payments")
    .upsert({ user_id: userId, ...payment } as never, {
      onConflict: "user_id,tax_year,quarter",
    });
  if (error) throw error;
}

export async function deletePayment(id: string): Promise<void> {
  const { error } = await supabase
    .from("estimated_tax_payments")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
