// US-1800: buyer entitlements — client side.
//
// The React mirror of the edge resolver (services/edge-functions/src/lib/
// buyer-entitlements.ts). Both read the SAME BUYER_PLANS matrix, so a feature is
// gated identically in the UI and on the edge. Use this to show/lock buyer
// features and to render upgrade affordances.
//
// FAIL-SAFE: an unknown/unset plan, or a paid plan whose subscription is not
// active/trialing, resolves to Free (paid flags off) — the UI denies by default.

import { useMemo } from "react";
import { useAuthStore } from "@/stores/auth-store";
import {
  BUYER_PLANS,
  type BuyerGateFlags,
  type BuyerPlanConfig,
  type BuyerPlanKey,
} from "@/lib/constants";

// Keep in lockstep with ACTIVE_STATUSES in the edge resolver.
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export interface BuyerEntitlements {
  plan: BuyerPlanKey;
  config: BuyerPlanConfig;
  gateFlags: BuyerGateFlags;
  /** True when the buyer's plan unlocks `feature`. */
  has: (feature: keyof BuyerGateFlags) => boolean;
  /** Whether the account carries the buyer role at all (US-1796). */
  isBuyer: boolean;
}

export function resolveBuyerPlanKey(
  plan: string | null | undefined,
  status: string | null | undefined,
): BuyerPlanKey {
  const isKnownPaid = plan === "guard" || plan === "connoisseur";
  return isKnownPaid && ACTIVE_STATUSES.has(status ?? "") ? plan : "free";
}

export function useBuyerEntitlements(): BuyerEntitlements {
  const profile = useAuthStore((s) => s.profile);
  return useMemo(() => {
    const plan = resolveBuyerPlanKey(
      profile?.buyer_plan,
      profile?.buyer_subscription_status,
    );
    const config = BUYER_PLANS[plan];
    return {
      plan,
      config,
      gateFlags: config.gateFlags,
      has: (feature) => config.gateFlags[feature] === true,
      isBuyer: profile?.is_buyer === true,
    };
  }, [profile?.buyer_plan, profile?.buyer_subscription_status, profile?.is_buyer]);
}
