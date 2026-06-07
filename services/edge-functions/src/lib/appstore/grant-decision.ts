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
