// Pure double-billing precedence. Avoids charging an App Store subscription on
// top of an active Stripe one.

import type { ProductMapping } from "./products.ts";

export interface BillingUserRow {
  billing_source?: string | null;
  subscription_status?: string | null;
  /** Stripe subscription id — set when a Stripe sub exists. */
  flipdesk_subscription_id?: string | null;
}

export type PrecedenceDecision = "proceed" | "block_active_stripe";

const STRIPE_ENTITLING_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * Consumables are always allowed (additive, processor-agnostic). A subscription
 * purchase is blocked when the user already has an entitling Stripe subscription
 * — the caller should return 409 and steer the user to manage Stripe first. We
 * never auto-cancel Stripe from the Apple path.
 */
export function decideAppstorePrecedence(
  user: BillingUserRow,
  kind: ProductMapping["kind"],
): PrecedenceDecision {
  if (kind === "consumable") return "proceed";

  const stripeActive =
    user.flipdesk_subscription_id != null &&
    (user.billing_source == null || user.billing_source === "stripe") &&
    STRIPE_ENTITLING_STATUSES.has(user.subscription_status ?? "");

  return stripeActive ? "block_active_stripe" : "proceed";
}

// ── Reverse direction (US-807): block a Stripe subscription mutation when an
// App Store subscription already entitles the user. The web Billing page must
// not start a second (Stripe) subscription on top of an active iOS one. This is
// the mirror of decideAppstorePrecedence: there the Apple path yields to Stripe;
// here the Stripe path (web subscribe / downgrade) yields to Apple. Consumables
// (credit packs / per-grade) are additive and never blocked — they don't call
// this. Returns true ⇒ the caller should respond 409 ACTIVE_APPSTORE_SUBSCRIPTION
// and steer the user to manage their plan in the iOS app.
const APPSTORE_ENTITLING_STATUSES = new Set(["active", "trialing", "past_due"]);

/** True when the user is currently entitled through an App Store subscription. */
export function appstoreSubscriptionActive(
  user: Pick<BillingUserRow, "billing_source" | "subscription_status">,
): boolean {
  return (
    user.billing_source === "appstore" &&
    APPSTORE_ENTITLING_STATUSES.has(user.subscription_status ?? "")
  );
}

export function appstoreSubscriptionBlocksStripe(
  user: Pick<BillingUserRow, "billing_source" | "subscription_status">,
): boolean {
  return appstoreSubscriptionActive(user);
}

// US-2126: Google Play is a THIRD subscription processor whose server side is
// live (lib/google-play/*), but it appeared in NEITHER precedence guard — so a
// Play subscriber could stack an App Store OR a Stripe subscription and be
// double-charged. This is the Play analogue of appstoreSubscriptionActive:
// billing_source is stamped 'googleplay' by the Play verify/RTDN path
// (lib/google-play/products.ts). The entitling statuses are the same three the
// App Store and Stripe guards use. Wired into all three purchase paths (App
// Store verify, Google Play verify, Stripe subscribe) so any two processors
// cannot both bill the same user.
/** True when the user is currently entitled through a Google Play subscription. */
export function googleplaySubscriptionActive(
  user: Pick<BillingUserRow, "billing_source" | "subscription_status">,
): boolean {
  return (
    user.billing_source === "googleplay" &&
    APPSTORE_ENTITLING_STATUSES.has(user.subscription_status ?? "")
  );
}

// US-1640: a DELAYED App Store EXPIRED/REVOKE must not clobber a Stripe
// subscription the user started in the meantime. A lapse notification would
// downgrade the user to free + stamp billing_source='appstore'; if they now
// hold a live Stripe sub, the webhook must SKIP the write (mirrors the expiry
// sweep's billing_source='appstore' guard). Returns true ⇒ skip the lapse.
// `lapses` = the notification would downgrade the user (computed update →
// subscription_status 'canceled'). A non-lapse (renewal/re-entitle) is never
// skipped here.
export function appstoreLapseSkippedByStripe(
  lapses: boolean,
  user: BillingUserRow,
): boolean {
  return (
    lapses &&
    decideAppstorePrecedence(user, "subscription") === "block_active_stripe"
  );
}

// ── The BUYER product (US-2456) ─────────────────────────────────────────────
//
// Every guard above reads the SELLER column family — `billing_source`,
// `subscription_status`, `flipdesk_subscription_id`. The buyer product has its
// own (`buyer_billing_source`, `buyer_subscription_status`,
// `buyer_subscription_id`) and had no precedence guard on the Stripe side at
// all: POST /buyer/subscribe would happily start a second subscription over a
// live App Store or Google Play one, and the customer is then charged twice, on
// two cards, for the same entitlement. Apple's half we cannot refund from here.
//
// The reverse direction was already covered, but hand-rolled inline in
// routes/appstore.ts rather than here — which is exactly why nobody noticed the
// other half was missing. Both directions now come from this module.
//
// A SEPARATE TYPE, not a widened one. `BillingUserRow` fields are seller
// columns; letting a buyer row satisfy it is how a helper ends up reading the
// wrong family and answering confidently about the wrong subscription.

export interface BuyerBillingUserRow {
  buyer_billing_source?: string | null;
  buyer_subscription_status?: string | null;
  buyer_subscription_id?: string | null;
}

/** Which processor currently entitles this buyer, if any. */
export function buyerEntitlingProcessor(
  user: BuyerBillingUserRow,
): "appstore" | "googleplay" | "stripe" | null {
  const source = user.buyer_billing_source;
  if (source !== "appstore" && source !== "googleplay" && source !== "stripe") {
    return null;
  }
  // Same three statuses the seller guards use. past_due IS entitling: the
  // subscription still exists and is being retried, so stacking a second one is
  // still a double charge — the inline check in routes/appstore.ts omitted it,
  // which let a buyer whose Stripe card was failing stack an Apple purchase.
  return APPSTORE_ENTITLING_STATUSES.has(user.buyer_subscription_status ?? "")
    ? source
    : null;
}

/**
 * True when a MOBILE processor already entitles this buyer, so a Stripe
 * subscribe must refuse. Mirrors appstoreSubscriptionBlocksStripe /
 * googleplaySubscriptionActive for the buyer column family.
 *
 * Never auto-cancels the other processor — the caller returns 409 and steers
 * the customer to manage the subscription where they bought it, which is the
 * only place Apple or Google will let them.
 */
export function buyerMobileSubscriptionBlocksStripe(
  user: BuyerBillingUserRow,
): "appstore" | "googleplay" | null {
  const processor = buyerEntitlingProcessor(user);
  return processor === "appstore" || processor === "googleplay" ? processor : null;
}

/** True when a live Stripe buyer subscription must block a mobile purchase. */
export function buyerStripeSubscriptionBlocksMobile(
  user: BuyerBillingUserRow,
): boolean {
  return buyerEntitlingProcessor(user) === "stripe";
}
