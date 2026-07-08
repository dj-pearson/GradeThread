// US-1800: buyer entitlements + plan-gating (edge side).
//
// Single source of truth for "what does this buyer's plan unlock?" on the edge.
// The React app resolves the same matrix client-side (use-buyer-entitlements.ts)
// from the identical BUYER_PLANS config, so client and edge agree.
//
// FAIL-SAFE: an unknown/unset plan, OR a paid plan whose subscription is not
// currently active/trialing, resolves to FREE (paid flags off). Gating therefore
// denies by default — a lapsed or unrecognized subscription never grants a paid
// capability.
//
// TENANT ISOLATION (US-268): the buyer plan is PERSONAL to the account (not
// workspace-shared), so getBuyerEntitlements reads the buyer's OWN users row
// scoped by the authenticated id (`c.get("userId")`), never an id taken from the
// request body. A buyer route that gates on this passes the authenticated id in
// and adds a tenant-isolation_test.ts case (the first such route ships in the
// billing/feature stories).

import type { Context } from "hono";
import { supabaseAdmin } from "./supabase.ts";
import {
  BUYER_PLAN_ENTITLEMENTS,
  type BuyerAllowances,
  type BuyerFeature,
  type BuyerGateFlags,
  type BuyerPlanKey,
} from "./buyer-plans.ts";

// Subscription statuses that keep a paid plan's entitlements live. `past_due`,
// `paused`, `canceled`, `none` all fall back to Free (deny paid caps).
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export interface BuyerEntitlements {
  plan: BuyerPlanKey;
  gateFlags: BuyerGateFlags;
  allowances: BuyerAllowances;
}

/** Pure resolver. Free is the fail-safe floor for any unknown/lapsed input. */
export function resolveBuyerEntitlements(
  plan: string | null | undefined,
  status: string | null | undefined,
): BuyerEntitlements {
  const isKnownPaid = plan === "guard" || plan === "connoisseur";
  const key: BuyerPlanKey = isKnownPaid && ACTIVE_STATUSES.has(status ?? "")
    ? plan
    : "free";
  return { plan: key, ...BUYER_PLAN_ENTITLEMENTS[key] };
}

/** True when the plan unlocks `feature`. */
export function buyerFeatureEnabled(
  ent: BuyerEntitlements,
  feature: BuyerFeature,
): boolean {
  return ent.gateFlags[feature] === true;
}

/**
 * Load a buyer's entitlements from their OWN users row. `userId` MUST be the
 * authenticated id (c.get("userId")) — never a request-body value — so this read
 * is tenant-scoped by construction. Falls back to Free on any read gap.
 */
export async function getBuyerEntitlements(userId: string): Promise<BuyerEntitlements> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("buyer_plan, buyer_subscription_status")
    .eq("id", userId)
    .maybeSingle();
  return resolveBuyerEntitlements(
    (data as { buyer_plan?: string } | null)?.buyer_plan,
    (data as { buyer_subscription_status?: string } | null)?.buyer_subscription_status,
  );
}

/**
 * Route guard: resolves the caller's buyer entitlements and, when `feature` is
 * not unlocked, returns a 402 upgrade-required Response the frontend renders as
 * a buyer upgrade prompt (mirrors the FlipDesk requireFlipdesk contract). Returns
 * the entitlements object when allowed so the handler can read allowances too.
 */
export async function requireBuyerFeature(
  c: Context,
  feature: BuyerFeature,
): Promise<BuyerEntitlements | Response> {
  const userId = c.get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const ent = await getBuyerEntitlements(userId);
  if (!buyerFeatureEnabled(ent, feature)) {
    return c.json(
      {
        error: "upgrade_required",
        product: "buyer",
        feature,
        current_plan: ent.plan,
      },
      402,
    );
  }
  return ent;
}
