// The flipdesk.payouts widget's arithmetic: which eBay payouts are on the way,
// which failed, and how their amounts read.

/** Payout states that mean the money is on its way. */
export const PENDING_PAYOUT_STATES = new Set(["INITIATED", "PROCESSING"]);

/**
 * A payout eBay tried to send and could not. It is NOT money on the way: the
 * seller usually has to fix a bank detail first, so it gets its own line.
 */
export const FAILED_PAYOUT_STATE = "RETRYABLE_FAILED";

type Amount = { value: string; currency: string } | null;

/** Sum per currency, formatted, e.g. "$120.00 + CA$40.00". */
export function formatPayoutTotals(amounts: readonly Amount[]): string {
  const byCurrency = new Map<string, number>();
  for (const a of amounts) {
    const n = Number(a?.value);
    if (!Number.isFinite(n)) continue;
    const cur = a?.currency || "USD";
    byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + n);
  }
  if (byCurrency.size === 0) return formatMoney(0, "USD");
  return [...byCurrency.entries()]
    .map(([cur, n]) => formatMoney(n, cur))
    .join(" + ");
}

function formatMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    // An unknown ISO code: say the number and the code rather than throw.
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** The soonest dated payout in a list, or null when none carries a date. */
export function nextPayoutDate(dates: readonly (string | null)[]): Date | null {
  const times = dates
    .map((d) => (d ? new Date(d).getTime() : Number.NaN))
    .filter((t) => Number.isFinite(t));
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}
