// US-2022: what to do with a consignor payout when its sale is later returned,
// refunded or cancelled. Pure decision logic — no IO — so every branch is
// unit-testable (consignor-reversal_test.ts).
//
// THE EXPOSURE THIS CLOSES: a $200 consigned item at a 60% split transfers $120
// to the consignor. The buyer returns it 20 days later and eBay refunds them
// $200 from the seller. Before this, the payout row stayed 'paid' forever, no
// money came back, and NOTHING signalled the loss. The payout engine was not
// buggy — this was a missing EDGE between two subsystems that each worked.
//
// ── Why reversal rather than a negative-balance offset ──────────────
//
// The AC offered either a Stripe transfers.createReversal or a negative row
// that offsets the consignor's next payout. Reversal is chosen because:
//
//   1. consignor_payouts.amount carries a CHECK (amount >= 0) since migration
//      00171, so a negative row cannot even be written without dropping a
//      constraint that is otherwise protecting the ledger.
//   2. An offset only recovers money if the consignor HAS a next payout. For a
//      one-off consignor — the common case for a returned item — it recovers
//      nothing and quietly becomes a bad debt with no owner.
//   3. Reversal returns funds to the platform balance immediately and is the
//      exact inverse of the original transfer, so the ledger reads as a pair.
//
// The failure mode is real and handled rather than ignored: a reversal fails if
// the connected account has already paid the funds out to its bank. That is
// what CLAWBACK_PENDING is for — the money is genuinely gone and only a human
// can recover it, so the row says so loudly instead of lying about being paid.

/** Statuses a payout row can hold (mirrors the consignor_payout_status enum). */
export type PayoutStatus =
  | "pending"
  | "processing"
  | "paid"
  | "failed"
  | "canceled"
  | "reversed"
  | "clawback_pending";

export interface ReversiblePayout {
  id: string;
  status: string;
  amount: number;
  stripe_transfer_id: string | null;
}

export type ReversalPlan =
  /** No money moved — kill the row so it can never be picked up and paid. */
  | { action: "cancel"; payoutId: string; reason: "not_yet_transferred" }
  /** Money moved — pull it back from the connected account. */
  | { action: "reverse"; payoutId: string; transferId: string; amount: number }
  /**
   * Money moved but we have no transfer id to reverse against. Cannot be
   * automated; must surface for a human rather than be silently dropped.
   */
  | { action: "flag"; payoutId: string; reason: "paid_without_transfer_id" }
  /** Terminal or already handled — nothing to do. */
  | { action: "skip"; payoutId: string; reason: "already_reversed" | "already_canceled" | "zero_amount" };

/**
 * Decide what a single payout row needs when its sale reverses.
 *
 * 'processing' is deliberately treated as NOT-yet-transferred and cancelled:
 * the transfer has not been confirmed, and the engine's pre-flight transfer
 * lookup (fireTransfer) re-checks Stripe before creating one, so a cancelled
 * row cannot strand an in-flight transfer — it can only stop a future one.
 */
export function planReversal(payout: ReversiblePayout): ReversalPlan {
  const { id, status } = payout;

  if (status === "reversed") return { action: "skip", payoutId: id, reason: "already_reversed" };
  if (status === "canceled") return { action: "skip", payoutId: id, reason: "already_canceled" };

  // Already known-unrecoverable — leave it flagged rather than retry forever.
  if (status === "clawback_pending") {
    return { action: "flag", payoutId: id, reason: "paid_without_transfer_id" };
  }

  if (status === "paid") {
    const amount = Number(payout.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { action: "skip", payoutId: id, reason: "zero_amount" };
    }
    const transferId = (payout.stripe_transfer_id ?? "").trim();
    if (!transferId) {
      return { action: "flag", payoutId: id, reason: "paid_without_transfer_id" };
    }
    return { action: "reverse", payoutId: id, transferId, amount };
  }

  // pending / failed / processing / anything unrecognised → no money left the
  // platform, so cancelling is both safe and the conservative default. An
  // unknown status reaching here is better cancelled than paid: the worst case
  // is a consignor payout that needs re-issuing, versus money leaving for a
  // sale that no longer exists.
  return { action: "cancel", payoutId: id, reason: "not_yet_transferred" };
}

/** Sale statuses that mean the sale came apart and any payout must reverse. */
export const REVERSING_SALE_STATUSES = new Set(["returned", "refunded", "cancelled", "canceled"]);

export function isReversingSaleStatus(status: string | null | undefined): boolean {
  return REVERSING_SALE_STATUSES.has((status ?? "").trim().toLowerCase());
}

// ── Hold window (AC3) ───────────────────────────────────────────────
//
// The cheapest mitigation for most of this exposure is not paying out until the
// return window closes: no transfer means nothing to claw back. Mirrors the
// affiliate engine's hold_days.
//
// DEFAULT 0 = OFF, i.e. today's behaviour (pay immediately). Turning it on is
// deliberately an operator decision, NOT a default: delaying every consignor
// payout by ~30 days changes when real people get paid and may contradict terms
// a seller already promised their consignors. The lever exists; the policy is
// the seller's to set.

export const CONSIGNOR_PAYOUT_CONFIG_KEY = "consignor_payout_config";

export interface ConsignorPayoutConfig {
  /** Days to hold a payout after the sale before transferring. 0 = pay now. */
  hold_days: number;
}

export const DEFAULT_CONSIGNOR_PAYOUT_CONFIG: ConsignorPayoutConfig = { hold_days: 0 };

export function normalizeConsignorPayoutConfig(raw: unknown): ConsignorPayoutConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const n = typeof o.hold_days === "number" ? o.hold_days : Number(o.hold_days);
  return {
    hold_days: Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CONSIGNOR_PAYOUT_CONFIG.hold_days,
  };
}

/** ISO hold-until stamp for a payout created now, or null when the hold is off. */
export function holdUntilFor(config: ConsignorPayoutConfig, nowMs: number): string | null {
  if (config.hold_days <= 0) return null;
  return new Date(nowMs + config.hold_days * 24 * 60 * 60 * 1000).toISOString();
}

/** True when a hold stamp is set and still in the future. */
export function isHeld(holdUntil: string | null | undefined, nowMs: number): boolean {
  if (!holdUntil) return false;
  const t = Date.parse(holdUntil);
  return Number.isFinite(t) && t > nowMs;
}
