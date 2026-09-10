// US-3299: what one package costs before any discount.
//
// A sale needs the LIST price, and the five product families keep theirs in five
// different places: the FlipDesk plans in the pricing_plans row, the grade tiers
// and grade credit packs in pricing_config, the action packs compiled, the buyer
// plans compiled. Every price surface already reads its own; this is the one
// lookup that answers the question uniformly, keyed by the same DiscountTarget
// the campaign is aimed at.
//
// Returns null for a package whose price cannot be established. resolveDiscount
// then declines rather than guessing, which is the safe direction: no badge, and
// no coupon at checkout.

import type { DiscountTarget } from "./discount-campaigns.ts";
import { getFlipdeskPlanPrices, getGradePricing } from "./pricing-config.ts";
import { BUYER_PLAN_PRICE_CENTS, type BuyerPlanKey } from "./buyer-plans.ts";
import { ACTION_CREDIT_PACKS, type ActionCreditPackKey } from "./action-credits.ts";

export async function listPriceCents(target: DiscountTarget): Promise<number | null> {
  switch (target.kind) {
    case "flipdesk_plan": {
      const prices = await getFlipdeskPlanPrices();
      const plan = prices[target.key as keyof typeof prices];
      if (!plan) return null;
      return target.interval === "yearly" ? plan.yearly : plan.monthly;
    }

    case "buyer_plan": {
      const plan = BUYER_PLAN_PRICE_CENTS[target.key as BuyerPlanKey];
      if (!plan) return null;
      return target.interval === "yearly" ? plan.yearly : plan.monthly;
    }

    case "grade_tier": {
      // Operator-editable via pricing_config (US-885), so read the live value
      // rather than TIER_PRICE_CENTS — a sale priced off the compiled default
      // would advertise a saving against a price nobody is charged.
      const pricing = await getGradePricing();
      const tier = pricing.tiers[target.key as keyof typeof pricing.tiers];
      return tier ? tier.priceCents : null;
    }

    case "credit_pack": {
      const pricing = await getGradePricing();
      const credits = Number(target.key);
      const pack = pricing.packs.find((p) => p.credits === credits);
      return pack ? pack.priceCents : null;
    }

    case "action_pack": {
      const pack = ACTION_CREDIT_PACKS[target.key as ActionCreditPackKey];
      return pack ? pack.priceCents : null;
    }

    default:
      return null;
  }
}
