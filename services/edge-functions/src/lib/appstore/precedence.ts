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

export function appstoreSubscriptionBlocksStripe(
  user: Pick<BillingUserRow, "billing_source" | "subscription_status">,
): boolean {
  return (
    user.billing_source === "appstore" &&
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
