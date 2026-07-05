// Pure extraction of the consumable credit-grant params from a decoded
// transaction. Idempotency itself is enforced in the grant_appstore_credits RPC
// (keyed on transactionId); this just shapes the call.

import type { ProductMapping } from "./products.ts";
import type { DecodedTransactionLite } from "./types.ts";

export interface ConsumableGrant {
  credits: number;
  transactionId: string;
  originalTransactionId: string;
  productId: string;
}

export function computeConsumableGrant(
  txn: DecodedTransactionLite,
  mapping: Extract<ProductMapping, { kind: "consumable" }>,
): ConsumableGrant {
  return {
    credits: mapping.credits,
    transactionId: txn.transactionId,
    originalTransactionId: txn.originalTransactionId,
    productId: txn.productId,
  };
}

/**
 * True when Apple has refunded/revoked this transaction (revocationDate set), so
 * it must NOT entitle. The interactive /verify path checks this so a client
 * cannot re-present an already-refunded JWS to (re-)grant credits or a plan.
 * US-1615 / C2.
 */
export function isTransactionRevoked(txn: DecodedTransactionLite): boolean {
  return txn.revocationDate != null;
}
