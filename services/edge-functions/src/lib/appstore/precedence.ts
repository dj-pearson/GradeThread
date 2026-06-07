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
