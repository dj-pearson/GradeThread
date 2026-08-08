// US-2345 AC1: the admin CREDIT-PACK refund sequence, made testable.
//
// This is the second money path in admin-billing.ts and the more dangerous of
// the two, because it moves money in Stripe AND claws credits back out of the
// user's wallet. The manual charge refund (lib/admin-charge-refund.ts) only does
// the first half.
//
// It ran inline in the route, driving Stripe and the service-role client
// directly, so every branch below needed a Stripe account that fails on demand
// plus a database. That is why the branches that matter had no test.
//
// FOUR PROPERTIES, each of which is a way to lose money or leak data:
//
//   • THE OWNERSHIP GATE IS THE TENANT BOUNDARY (CLAUDE.md US-268). The charge
//     id arrives in the request body. Nothing about it is trusted until it is
//     tied to this user, by the user_id stamped on the pack checkout or by the
//     Stripe customer on their row. Without that an admin URL could refund one
//     user's charge and debit ANOTHER user's wallet — two victims from one call.
//   • A CHARGE WE COULD NOT READ IS NOT REFUNDED. The credit count comes out of
//     that read; proceeding without it means clawing back a number we invented.
//   • THE STRIPE REFUND FIRES FIRST, AND THAT ORDER IS DELIBERATE. If the ledger
//     reversal fails afterwards the money is already gone and the wallet is
//     still full — a real, reportable gap, and the handler says so with a 500
//     naming the refund id. The other order would be worse: credits revoked for
//     a refund that never happened leaves the user short with no recourse.
//   • THE LEDGER FAILURE STILL WRITES AN AUDIT ROW. This is the exact opposite
//     of the manual-refund rule next door, and the difference is what actually
//     happened: there, the refund threw and no money moved, so a row would be a
//     lie. Here the money DID move. The row carrying ledger_error is the only
//     record that a reconciliation is owed.
//
// The two idempotency keys are also pinned by the tests, because they are keyed
// on different things on purpose. Stripe's is per CHARGE, so a retried handler
// gets the same refund object instead of refunding twice. The ledger's is per
// REFUND (US-2033) — keying it per charge silently under-clawed a second partial
// refund on the same charge, because the webhook found the key already claimed
// and skipped its write.

import { resolveChargeMetadata } from "./stripe-metadata.ts";

export interface PackRefundIO {
  /** The target user row. Rejects/returns null when it cannot be read. */
  loadUser: (
    userId: string,
  ) => Promise<{ id: string; stripe_customer_id: string | null } | null>;
  retrieveCharge: (chargeId: string) => Promise<PackCharge>;
  /**
   * Metadata for a Checkout charge lives on the PaymentIntent, not the charge
   * (US-1414). Returning null means "could not read it", which is NOT the same
   * as "empty" — an empty object would say the charge belongs to nobody and
   * fail the ownership gate for the wrong reason.
   */
  retrieveIntentMetadata: (
    intentId: string,
  ) => Promise<Record<string, string> | null>;
  createRefund: (args: {
    chargeId: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }) => Promise<{ id: string; amount: number }>;
  revokeCredits: (args: {
    userId: string;
    credits: number;
    paymentIntentId: string | null;
    notes: string;
    idempotencyKey: string;
  }) => Promise<
    | { ok: true; result: RevokeResult }
    | { ok: false; message: string }
  >;
}

export interface PackCharge {
  refunded: boolean;
  customer: string | null;
  payment_intent: string | null;
  metadata: Record<string, string>;
}

export interface RevokeResult {
  revoked?: number;
  shortfall?: number;
  balance_after?: number;
  idempotent_replay?: boolean;
}

export type PackRefundOutcome =
  | {
    ok: true;
    refundId: string;
    refundAmountCents: number;
    /**
     * The pack SIZE from the charge metadata — what was sold. Deliberately not
     * `result.revoked`, which is what the wallet could actually give back and is
     * smaller whenever there is a shortfall. The audit row wants both, and
     * collapsing them would hide exactly the case an operator is looking for.
     */
    credits: number;
    result: RevokeResult;
  }
  /** Nothing was attempted. No money moved, no audit row is owed. */
  | {
    ok: false;
    stage: "reject";
    status: 403 | 404 | 409 | 422;
    message: string;
  }
  /** Stripe refused the refund. No money moved. */
  | { ok: false; stage: "refund"; status: 500; message: string }
  /**
   * THE MONEY IS GONE AND THE WALLET IS STILL FULL. The only outcome that both
   * fails and requires an audit row — the caller MUST write one carrying
   * `ledgerError`, or the gap exists with nothing recording it.
   */
  | {
    ok: false;
    stage: "ledger";
    status: 500;
    message: string;
    refundId: string;
    credits: number;
    ledgerError: string;
  };

/**
 * Refund one credit-pack charge and claw the credits back.
 *
 * `chargeId` and `targetUserId` both come from the request. Neither is trusted
 * until the ownership gate below ties them together.
 */
export async function performPackRefund(
  args: {
    targetUserId: string;
    adminId: string;
    chargeId: string;
    /** Free-text admin note, already trimmed and capped by the caller. */
    reasonNote: string;
  },
  io: PackRefundIO,
): Promise<PackRefundOutcome> {
  const user = await io.loadUser(args.targetUserId);
  if (!user) {
    return {
      ok: false,
      stage: "reject",
      status: 404,
      message: "User not found",
    };
  }

  let charge: PackCharge;
  try {
    charge = await io.retrieveCharge(args.chargeId);
  } catch (err) {
    return {
      ok: false,
      stage: "reject",
      status: 404,
      message: `Charge lookup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // The shared resolver, not a local reimplementation. Its gate is "does this
  // metadata carry our user_id", NOT "is it non-empty" — a charge stamped with a
  // product but no user_id must still reach through to the PaymentIntent, and a
  // second copy of that rule would be the one that forgot.
  const meta = await resolveChargeMetadata(
    { metadata: charge.metadata, payment_intent: charge.payment_intent },
    io.retrieveIntentMetadata,
  );

  // ── The tenant boundary. Two ways to prove the charge is this user's, and
  // the charge is refused unless one of them holds. ──
  const ownsByMetadata = (meta.user_id ?? null) === args.targetUserId;
  const ownsByCustomer = Boolean(user.stripe_customer_id) &&
    charge.customer === user.stripe_customer_id;
  if (!ownsByMetadata && !ownsByCustomer) {
    return {
      ok: false,
      stage: "reject",
      status: 403,
      message: "Charge does not belong to this user.",
    };
  }

  if (meta.product !== "credit_pack") {
    return {
      ok: false,
      stage: "reject",
      status: 422,
      message:
        "Not a credit-pack charge. Use Recent charges → Refund for other charges.",
    };
  }
  if (charge.refunded) {
    return {
      ok: false,
      stage: "reject",
      status: 409,
      message: "Charge is already fully refunded.",
    };
  }

  const credits = Number.parseInt(meta.credits ?? "", 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    return {
      ok: false,
      stage: "reject",
      status: 422,
      message: "Charge has no valid credit count in metadata.",
    };
  }

  // (1) The money. Keyed on the CHARGE so a retried handler gets the same refund
  // object back rather than issuing a second one.
  let refund: { id: string; amount: number };
  try {
    refund = await io.createRefund({
      chargeId: args.chargeId,
      metadata: {
        admin_id: args.adminId,
        product: "credit_pack",
        ...(args.reasonNote ? { admin_reason: args.reasonNote } : {}),
      },
      idempotencyKey: `pack-refund:${args.chargeId}`,
    });
  } catch (err) {
    return {
      ok: false,
      stage: "refund",
      status: 500,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // (2) The wallet. Keyed on the REFUND (US-2033) — the same key the
  // charge.refunded webhook uses, so whichever path runs first does the write
  // and the other no-ops.
  const revoke = await io.revokeCredits({
    userId: args.targetUserId,
    credits,
    paymentIntentId: charge.payment_intent,
    notes:
      `Admin pack refund for charge ${args.chargeId} by ${args.adminId} (refund ${refund.id})`,
    idempotencyKey: `pack-refund:${refund.id}`,
  });

  if (!revoke.ok) {
    return {
      ok: false,
      stage: "ledger",
      status: 500,
      message:
        "Refund issued, but the ledger reversal failed — reconcile manually.",
      refundId: refund.id,
      credits,
      ledgerError: revoke.message.slice(0, 500),
    };
  }

  return {
    ok: true,
    refundId: refund.id,
    refundAmountCents: refund.amount,
    credits,
    result: revoke.result,
  };
}
