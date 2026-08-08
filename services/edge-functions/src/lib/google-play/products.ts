// Google Play product catalog — the Android counterpart to
// lib/appstore/products.ts. Maps Play Console product ids to the SAME
// ProductMapping (plan/interval or credits) the App Store + Stripe flows use, so
// a Play purchase flips identical server-side state.
//
// IMPORTANT: these product ids MUST match the SKUs configured in the Google Play
// Console (Monetize → Products). They are intentionally Play-style ids (lowercase
// + underscores), distinct from the iOS bundle-style ids. Subscriptions are one
// product id per plan+interval (mirroring the iOS structure) rather than one
// subscription id with base plans, so the mapping stays deterministic from the
// reported product id alone.

import type { BillingEnvironment } from "../billing-environment.ts";
import type {
  BillingInterval,
  FlipdeskPlan,
  ProductMapping,
} from "../appstore/products.ts";

export type { BillingInterval, FlipdeskPlan, ProductMapping };

export const ANDROID_CATALOG: Record<string, Exclude<ProductMapping, { kind: "buyer_subscription" }>> = {
  // Subscriptions
  flipdesk_starter_monthly: { kind: "subscription", plan: "starter", interval: "monthly" },
  flipdesk_starter_yearly: { kind: "subscription", plan: "starter", interval: "yearly" },
  flipdesk_pro_monthly: { kind: "subscription", plan: "pro", interval: "monthly" },
  flipdesk_pro_yearly: { kind: "subscription", plan: "pro", interval: "yearly" },
  flipdesk_business_monthly: { kind: "subscription", plan: "business", interval: "monthly" },
  flipdesk_business_yearly: { kind: "subscription", plan: "business", interval: "yearly" },
  // Consumable credit packs
  credits_10: { kind: "consumable", credits: 10 },
  credits_25: { kind: "consumable", credits: 25 },
  credits_50: { kind: "consumable", credits: 50 },
  credits_100: { kind: "consumable", credits: 100 },
};

// US-1804: buyer subscription products (Google Play), separate from the seller
// catalog. Play-style ids matching the Stripe lookup keys + iOS structure.
export const BUYER_ANDROID_CATALOG: Record<string, Extract<ProductMapping, { kind: "buyer_subscription" }>> = {
  buyer_guard_monthly: { kind: "buyer_subscription", plan: "guard", interval: "monthly" },
  buyer_guard_yearly: { kind: "buyer_subscription", plan: "guard", interval: "yearly" },
  buyer_connoisseur_monthly: { kind: "buyer_subscription", plan: "connoisseur", interval: "monthly" },
  buyer_connoisseur_yearly: { kind: "buyer_subscription", plan: "connoisseur", interval: "yearly" },
};

/** Fail-closed: unknown product ids return null (never entitle).
 *  NOTE (US-1804): buyer products are intentionally NOT wired into the Google
 *  verify orchestration yet — a buyer product id returns null here (clean
 *  "unknown product" 400) rather than misfiring as a consumable. Android buyer
 *  IAP wiring (processGooglePlayPurchase buyer branch + a buyer apply dep) is a
 *  focused follow-up; BUYER_ANDROID_CATALOG + computeGoogleBuyerUserUpdate below
 *  are the ready pieces for it. Apple buyer IAP is fully wired. */
export function classifyAndroidProduct(
  productId: string,
): Exclude<ProductMapping, { kind: "buyer_subscription" }> | null {
  return ANDROID_CATALOG[productId] ?? null;
}

export const ANDROID_SUBSCRIPTION_PRODUCT_IDS: string[] = Object.entries(ANDROID_CATALOG)
  .filter(([, m]) => m.kind === "subscription")
  .map(([id]) => id);

export const ANDROID_CONSUMABLE_PRODUCT_IDS: string[] = Object.entries(ANDROID_CATALOG)
  .filter(([, m]) => m.kind === "consumable")
  .map(([id]) => id);

// ── Subscription → users-row update (pure) ──────────────────────────

/** The users-row update for a verified Google Play subscription. Mirrors the
 * App Store's UsersBillingUpdate but with billing_source='googleplay' and the
 * Play identifiers, so a later RTDN webhook can reconcile by purchase token. */
export interface GoogleUsersBillingUpdate {
  flipdesk_plan: FlipdeskPlan | "free";
  flipdesk_interval: BillingInterval | null;
  subscription_status: "active" | "canceled";
  flipdesk_period_end: string | null;
  flipdesk_cancel_at_period_end: boolean;
  billing_source: "googleplay";
  /** US-2286: 'sandbox' when Google flagged a licence-tester purchase. */
  billing_environment: BillingEnvironment;
  google_purchase_token: string;
  google_product_id: string;
}

/**
 * Compute the users-row update for a verified subscription purchase. PURE —
 * `now` is epoch ms. A subscription whose `expiryMillis` is in the past lapses
 * the user to free/canceled; otherwise it's active. `autoRenewing=false` means
 * the user has cancelled but keeps access until period end.
 */
export function computeGoogleUserUpdate(params: {
  mapping: Extract<ProductMapping, { kind: "subscription" }>;
  productId: string;
  purchaseToken: string;
  expiryMillis: number | null;
  autoRenewing: boolean;
  now: number;
  /** Omitted by callers that predate US-2286; absent is treated as sandbox,
   * matching the App Store half — an unmarked grant is not vouched-for. */
  environment?: BillingEnvironment;
}): GoogleUsersBillingUpdate {
  const { mapping, productId, purchaseToken, expiryMillis, autoRenewing, now } = params;
  const expired = expiryMillis != null && expiryMillis <= now;
  return {
    flipdesk_plan: expired ? "free" : mapping.plan,
    flipdesk_interval: expired ? null : mapping.interval,
    subscription_status: expired ? "canceled" : "active",
    flipdesk_period_end: expiryMillis != null ? new Date(expiryMillis).toISOString() : null,
    flipdesk_cancel_at_period_end: !autoRenewing,
    billing_source: "googleplay",
    billing_environment: params.environment ?? "sandbox",
    google_purchase_token: purchaseToken,
    google_product_id: productId,
  };
}

// US-1804: the users-row update for a verified BUYER Google Play subscription —
// writes ONLY the buyer_* column family, so entitlement resolution treats it
// identically to a Stripe/App Store buyer sub.
export interface GoogleBuyerUsersBillingUpdate {
  buyer_plan: "guard" | "connoisseur" | "free";
  buyer_interval: BillingInterval | null;
  buyer_subscription_status: "active" | "canceled";
  buyer_period_end: string | null;
  buyer_cancel_at_period_end: boolean;
  buyer_billing_source: "googleplay";
  /** US-2286, buyer half — see GoogleUsersBillingUpdate.billing_environment. */
  buyer_billing_environment: BillingEnvironment;
  buyer_google_purchase_token: string;
  buyer_google_product_id: string;
}

export function computeGoogleBuyerUserUpdate(params: {
  mapping: Extract<ProductMapping, { kind: "buyer_subscription" }>;
  productId: string;
  purchaseToken: string;
  expiryMillis: number | null;
  autoRenewing: boolean;
  now: number;
  environment?: BillingEnvironment;
}): GoogleBuyerUsersBillingUpdate {
  const { mapping, productId, purchaseToken, expiryMillis, autoRenewing, now } = params;
  const expired = expiryMillis != null && expiryMillis <= now;
  return {
    buyer_plan: expired ? "free" : mapping.plan,
    buyer_interval: expired ? null : mapping.interval,
    buyer_subscription_status: expired ? "canceled" : "active",
    buyer_period_end: expiryMillis != null ? new Date(expiryMillis).toISOString() : null,
    buyer_cancel_at_period_end: !autoRenewing,
    buyer_billing_source: "googleplay",
    buyer_billing_environment: params.environment ?? "sandbox",
    buyer_google_purchase_token: purchaseToken,
    buyer_google_product_id: productId,
  };
}
