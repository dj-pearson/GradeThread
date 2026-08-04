// US-2345 AC1: the admin manual-refund SEQUENCE, made testable.
//
// The pure decisions here were already extracted and covered — how much may be
// refunded (normalizeRefundAmount) and what the idempotency key is
// (refundIdempotencyKey), both in lib/refund-amount.ts. What had no test is the
// ORDER the steps run in and what happens when each one fails, because the
// handler drove Stripe and the audit log directly.
//
// That is the half where the damage lives. Every property below is about a
// failure branch:
//
//   • a charge we could not READ must not be refunded — the amount ceiling is
//     derived from that read, so proceeding without it means refunding an
//     unbounded amount;
//   • a refund that THREW must not leave an audit row saying it happened —
//     a false record of money moving is worse than no record, because the next
//     operator reconciles against it;
//   • the audit row must carry Stripe's numbers, not ours. Recording the
//     requested amount rather than `refund.amount` would hide a partial refund
//     that Stripe clamped.
import type { RefundAmountResult } from "./refund-amount.ts";

export interface AdminRefundIO {
  /** Current charge totals, for the refundable ceiling. */
  retrieveCharge: (
    chargeId: string,
  ) => Promise<{ amount: number | null; amount_refunded: number | null }>;
  createRefund: (args: {
    chargeId: string;
    /** Omitted entirely for a FULL refund — never sent as 0. */
    amount?: number;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }) => Promise<{ id: string; amount: number }>;
  writeAudit: (details: {
    refund_id: string;
    amount: number;
    reason: string | null;
  }) => Promise<void>;
}

export type AdminRefundOutcome =
  | { ok: true; refundId: string; amount: number }
  /** The charge could not be read — no refund was attempted. */
  | { ok: false; stage: "read"; status: 502; message: string }
  /** Stripe refused the refund, or the call failed. No audit row was written. */
  | { ok: false; stage: "refund"; status: 500; message: string };

/**
 * Issue one admin refund and record it.
 *
 * The caller has already validated the amount (it needs the ceiling this
 * function's first step produces, so validation sits between the two calls and
 * stays in the route). What is encapsulated here is the sequencing.
 */
export async function performAdminChargeRefund(
  chargeId: string,
  args: {
    parsed: Extract<RefundAmountResult, { ok: true }>;
    reason: string | null;
    adminId: string;
    /**
     * From refundIdempotencyKey(). Passed IN rather than derived here, because
     * the key and the amount validator must stay spelled the same way — US-2294
     * found them drifted, which produced a different key for the same effect
     * and let a double-click through the guard that exists to stop it.
     */
    idempotencyKey: string;
  },
  io: AdminRefundIO,
): Promise<AdminRefundOutcome> {
  let refund: { id: string; amount: number };
  try {
    refund = await io.createRefund({
      chargeId,
      ...(args.parsed.kind === "partial" ? { amount: args.parsed.amount } : {}),
      metadata: {
        admin_id: args.adminId,
        ...(args.reason ? { admin_reason: args.reason } : {}),
      },
      idempotencyKey: args.idempotencyKey,
    });
  } catch (err) {
    // NO AUDIT ROW. A refund that did not happen must not leave a record saying
    // it did — the next operator reconciles Stripe against this log, and a
    // phantom entry sends them looking for money that never moved.
    return {
      ok: false,
      stage: "refund",
      status: 500,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Stripe's numbers, not the requested ones: a partial refund Stripe clamped
  // would otherwise be recorded at the amount we asked for.
  await io.writeAudit({
    refund_id: refund.id,
    amount: refund.amount,
    reason: args.reason,
  });

  return { ok: true, refundId: refund.id, amount: refund.amount };
}

/**
 * The refundable ceiling, read before anything is charged back.
 *
 * Split out so the "we could not read it, so do not refund" branch is a value
 * rather than an early `return` buried in a 1,750-line route file.
 */
export async function refundableCeiling(
  chargeId: string,
  io: Pick<AdminRefundIO, "retrieveCharge">,
): Promise<{ ok: true; remainingCents: number } | { ok: false; message: string }> {
  try {
    const charge = await io.retrieveCharge(chargeId);
    return {
      ok: true,
      remainingCents: (charge.amount ?? 0) - (charge.amount_refunded ?? 0),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
