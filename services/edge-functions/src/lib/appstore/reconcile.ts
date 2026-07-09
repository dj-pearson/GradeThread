// Pure reconciler: given a decoded subscription transaction (+ optional renewal
// info) and a coarse action, compute the users-row update. The Apple analog of
// handleSubscriptionChange in routes/webhooks.ts — writes the SAME columns.

import type { AppstoreAction } from "./notifications.ts";
import type { BillingInterval, FlipdeskPlan, ProductMapping } from "./products.ts";
import type { DecodedRenewalLite, DecodedTransactionLite } from "./types.ts";

export interface UsersBillingUpdate {
  flipdesk_plan: FlipdeskPlan | "free";
  flipdesk_interval: BillingInterval | null;
  subscription_status: "active" | "canceled";
  flipdesk_period_end: string | null;
  flipdesk_cancel_at_period_end: boolean;
  billing_source: "appstore";
  appstore_original_transaction_id: string;
  appstore_product_id: string;
}

/**
 * Compute the users-row update for a subscription transaction.
 *
 * - `now` is epoch ms. A transaction whose `expiresDate` is in the past, or an
 *   `EXPIRED`/`REVOKE` action, lapses the user to `free` / `canceled`.
 * - `sub_renew_off`/`sub_renew_on` keep the user entitled but flip
 *   `flipdesk_cancel_at_period_end`; otherwise it's derived from
 *   `autoRenewStatus` when present.
 */
export function computeUserUpdate(params: {
  mapping: Extract<ProductMapping, { kind: "subscription" }>;
  txn: DecodedTransactionLite;
  renewal?: DecodedRenewalLite | null;
  action: AppstoreAction;
  now: number;
}): UsersBillingUpdate {
  const { mapping, txn, renewal, action, now } = params;

  const lapsed =
    action === "sub_expired" ||
    action === "revoke" ||
    (txn.expiresDate != null && txn.expiresDate <= now);

  const periodEnd =
    txn.expiresDate != null ? new Date(txn.expiresDate).toISOString() : null;

  const cancelAtPeriodEnd =
    action === "sub_renew_off"
      ? true
      : action === "sub_renew_on"
      ? false
      : renewal?.autoRenewStatus === 0;

  return {
    flipdesk_plan: lapsed ? "free" : mapping.plan,
    flipdesk_interval: lapsed ? null : mapping.interval,
    subscription_status: lapsed ? "canceled" : "active",
    flipdesk_period_end: periodEnd,
    flipdesk_cancel_at_period_end: lapsed ? false : cancelAtPeriodEnd,
    billing_source: "appstore",
    appstore_original_transaction_id: txn.originalTransactionId,
    appstore_product_id: txn.productId,
  };
}

// US-1804: the users-row update for a verified BUYER subscription IAP. Writes the
// buyer_* column family (00402/00414) so entitlement resolution treats it
// identically to a Stripe buyer sub. Never touches flipdesk_*.
export interface BuyerUsersBillingUpdate {
  buyer_plan: "guard" | "connoisseur" | "free";
  buyer_interval: BillingInterval | null;
  buyer_subscription_status: "active" | "canceled";
  buyer_period_end: string | null;
  buyer_cancel_at_period_end: boolean;
  buyer_billing_source: "appstore";
  buyer_appstore_original_transaction_id: string;
  buyer_appstore_product_id: string;
}

export function computeBuyerUserUpdate(params: {
  mapping: Extract<ProductMapping, { kind: "buyer_subscription" }>;
  txn: DecodedTransactionLite;
  renewal?: DecodedRenewalLite | null;
  action: AppstoreAction;
  now: number;
}): BuyerUsersBillingUpdate {
  const { mapping, txn, renewal, action, now } = params;

  const lapsed = action === "sub_expired" ||
    action === "revoke" ||
    (txn.expiresDate != null && txn.expiresDate <= now);

  const periodEnd = txn.expiresDate != null ? new Date(txn.expiresDate).toISOString() : null;

  const cancelAtPeriodEnd = action === "sub_renew_off"
    ? true
    : action === "sub_renew_on"
    ? false
    : renewal?.autoRenewStatus === 0;

  return {
    buyer_plan: lapsed ? "free" : mapping.plan,
    buyer_interval: lapsed ? null : mapping.interval,
    buyer_subscription_status: lapsed ? "canceled" : "active",
    buyer_period_end: periodEnd,
    buyer_cancel_at_period_end: lapsed ? false : cancelAtPeriodEnd,
    buyer_billing_source: "appstore",
    buyer_appstore_original_transaction_id: txn.originalTransactionId,
    buyer_appstore_product_id: txn.productId,
  };
}
