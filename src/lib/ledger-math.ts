// US-2984 — the ledger's arithmetic, in one place, with no database.
//
// The real invariant runs against Postgres (scripts/check-ledger-invariant.mjs).
// This file is the half of it that CI can run on every push: the money
// conversion, the sign convention, and the sale-to-entries derivation expressed
// as pure functions, so a change to either can be caught before it reaches a
// migration.
//
// SIGN CONVENTION, stated once and relied on everywhere: amount_cents is
// signed, and POSITIVE INCREASES PROFIT. Income is positive, every cost is
// negative. The alternative -- positive magnitudes with the account's flow
// deciding the sign at read time -- means every reader has to know the
// convention, and one of them eventually will not.

/** The accounts an entry can land on, matching src/lib/chart-of-accounts.ts. */
export type EntryAccountCode =
  | "sales_revenue"
  | "shipping_income"
  | "sales_tax_collected"
  | "platform_fees"
  | "shipping_postage"
  | "cogs_other"
  | "purchases"
  | "cash_payout";

export type SourceKind =
  | "sale"
  | "expense"
  | "fee"
  | "shipping"
  | "payout"
  | "adjustment"
  | "cogs";

export interface LedgerEntryDraft {
  account: EntryAccountCode;
  amount_cents: number;
  source_kind: SourceKind;
  source_detail: string;
}

/**
 * A money column to integer cents, exactly.
 *
 * Every money column this reads is `numeric(10,2)`, so the value has at most
 * two decimal places and `x * 100` is an integer. That is not a hope: the
 * multiply is done on the DIGITS rather than on a float, because 19.99 * 100 is
 * 1998.9999999999998 in IEEE 754 and rounding it happens to work while
 * `1.005 * 100` does not. Doing it wrong is invisible until a seller's total is
 * a cent off and they stop trusting the whole section.
 *
 * Accepts a number or the string PostgREST returns for a numeric column.
 * Returns 0 for null, undefined and blank -- a missing cost is zero, not NaN.
 */
export function toCents(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const s = typeof value === "number" ? value.toFixed(10) : String(value).trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return Number.NaN;
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] || "0";
  // Pad or truncate to exactly two decimal places, rounding half away from zero
  // on the third digit so a stray third decimal cannot silently vanish.
  const frac = m[3] ?? "";
  const twoDp = (frac + "00").slice(0, 2);
  const third = frac.length > 2 ? Number(frac[2]) : 0;
  const base = Number(whole) * 100 + Number(twoDp);
  return sign * (third >= 5 ? base + 1 : base);
}

/** Integer cents back to a display string. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** The money columns on a sale, as they arrive from PostgREST. */
export interface SaleMoney {
  sale_price: number | string;
  shipping_collected: number | string;
  platform_fees: number | string;
  payment_processing_fees: number | string;
  shipping_cost: number | string;
  grading_cost: number | string;
  other_costs: number | string;
  tax: number | string;
}

/**
 * finances_dashboard's pnl_net, term for term (migration 00143).
 *
 * Kept as its own function rather than inlined, so the test below can assert
 * the entry derivation reproduces it. Note what is ABSENT: `tax` appears
 * nowhere. Facilitator sales tax was never the seller's income and has never
 * been in this formula.
 */
export function saleNetCents(
  sale: SaleMoney,
  acquiredPrice: number | string | null,
  legacyShipTotal: number | string | null,
): number {
  const revenue = toCents(sale.sale_price) + toCents(sale.shipping_collected);
  const fees =
    toCents(sale.platform_fees) + toCents(sale.payment_processing_fees);
  const costs =
    toCents(sale.shipping_cost) +
    toCents(sale.grading_cost) +
    toCents(sale.other_costs);
  const basis = toCents(acquiredPrice);
  // The legacy shipments row counts ONLY when the sale row carries no shipping
  // of its own. Without this guard the label is deducted twice, which is the
  // exact defect the SQL sabotage run reproduced.
  const legacy = toCents(sale.shipping_cost) === 0 ? toCents(legacyShipTotal) : 0;
  return revenue - fees - costs - basis - legacy;
}

/**
 * The entries one completed sale becomes.
 *
 * Mirrors rebuild_ledger_for_user() in migration 00685. Zero-valued components
 * produce no entry: a books screen full of $0.00 rows is noise a seller has to
 * read past to find the row that matters.
 */
export function saleEntries(
  sale: SaleMoney,
  acquiredPrice: number | string | null,
  legacyShipTotal: number | string | null,
): LedgerEntryDraft[] {
  const out: LedgerEntryDraft[] = [];
  const push = (
    account: EntryAccountCode,
    cents: number,
    source_kind: SourceKind,
    source_detail: string,
  ) => {
    if (cents !== 0) out.push({ account, amount_cents: cents, source_kind, source_detail });
  };

  push("sales_revenue", toCents(sale.sale_price), "sale", "price");
  push("shipping_income", toCents(sale.shipping_collected), "sale", "shipping");
  push("sales_tax_collected", toCents(sale.tax), "sale", "tax");
  push(
    "platform_fees",
    -(toCents(sale.platform_fees) + toCents(sale.payment_processing_fees)),
    "fee",
    "fees",
  );
  push("shipping_postage", -toCents(sale.shipping_cost), "shipping", "label");
  push("cogs_other", -toCents(sale.grading_cost), "cogs", "grading");
  push("cogs_other", -toCents(sale.other_costs), "cogs", "other");
  push("purchases", -toCents(acquiredPrice), "cogs", "cogs");
  if (toCents(sale.shipping_cost) === 0) {
    push(
      "shipping_postage",
      -toCents(legacyShipTotal),
      "shipping",
      "legacy_shipment",
    );
  }
  return out;
}

/** Accounts whose entries are recorded but never reach profit. */
export const NON_PROFIT_ACCOUNTS: ReadonlySet<string> = new Set([
  "sales_tax_collected",
  "cash_payout",
]);

/**
 * Net over a set of entries.
 *
 * Excluded and asset accounts are recorded but do not move profit -- sales tax
 * was never income, and a payout is money already counted when the sale
 * happened. Counting either would double a seller's income.
 */
export function ledgerNetCents(entries: readonly LedgerEntryDraft[]): number {
  return entries.reduce(
    (sum, e) =>
      NON_PROFIT_ACCOUNTS.has(e.account) ? sum : sum + e.amount_cents,
    0,
  );
}
