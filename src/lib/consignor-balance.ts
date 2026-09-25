import type { ConsignorPnlRow } from "@/types/database";

// C9: what a consignor is really owed, in cents-safe math.
//
// consignor_pnl.balance_owed is GREATEST(share - paid, 0). It does not take
// out payouts already queued or processing, so the page offered that money a
// second time, and the clamp hid a consignor who had been overpaid. This
// reads the raw columns instead:
//
//   raw       = consignor_share - payouts_paid
//   available = max(raw - payouts_pending, 0)   (safe to pay now)
//   pending   = payouts_pending                 (already in flight)
//   overpaid  = raw < 0 ? -raw : 0              (paid more than their share)
//
// Everything is summed in integer cents so float noise never shows up as a
// stray cent. Values come back in dollars.

export interface ConsignorBalance {
  available: number;
  pending: number;
  overpaid: number;
}

function cents(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function consignorBalance(
  pnl: Pick<ConsignorPnlRow, "consignor_share" | "payouts_paid" | "payouts_pending"> | null | undefined,
): ConsignorBalance {
  if (!pnl) return { available: 0, pending: 0, overpaid: 0 };
  const raw = cents(pnl.consignor_share) - cents(pnl.payouts_paid);
  const pending = Math.max(cents(pnl.payouts_pending), 0);
  return {
    available: Math.max(raw - pending, 0) / 100,
    pending: pending / 100,
    overpaid: raw < 0 ? -raw / 100 : 0,
  };
}

// C12: the live example under the split input.
// "On a $100 sale with $13 fees, they get $X."
export function splitExample(splitPct: number): string {
  const pct = Number.isFinite(splitPct) ? Math.min(100, Math.max(0, splitPct)) : 0;
  return `On a $100 sale with $13 fees, they get $${((8700 * pct) / 10000).toFixed(2)}.`;
}
