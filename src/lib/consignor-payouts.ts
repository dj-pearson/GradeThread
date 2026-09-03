import type { ConsignorPayoutRow } from "@/types/database";

// US-3078 AC6: what "a payout is due" means, in one place with no React in it.
//
// Separate from the widget for the reason src/pages/flipdesk/needs-you.ts is
// separate from the card that renders it: the rule about which states count is
// the part worth testing, and testing it should not need a query client.

/**
 * Payout states where the consignor has not been paid.
 *
 * `processing` counts: the transfer is in flight rather than settled, and a
 * seller reading "nobody is owed" while money is moving would close the page
 * believing the ledger is clear. `paid`, `canceled` and `reversed` are
 * finished. `clawback_pending` is money owed BACK to the seller after a sale
 * reversed, which points the other way and belongs on a different card.
 */
const DUE_STATES = new Set(["pending", "processing", "failed"]);

export interface DuePayoutSummary {
  /** How many distinct consignors are owed something. */
  consignors: number;
  /** How many payout rows make that up. */
  payouts: number;
  totalDue: number;
}

/** The consignors owed, and the total owed to them. */
export function summarizeDuePayouts(
  rows: readonly ConsignorPayoutRow[],
): DuePayoutSummary {
  const due = rows.filter((r) => DUE_STATES.has(r.status));
  return {
    consignors: new Set(due.map((r) => r.consignor_id)).size,
    payouts: due.length,
    totalDue: due.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
  };
}
