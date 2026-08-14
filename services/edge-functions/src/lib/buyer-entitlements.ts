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
import { effectivePlanFor } from "./grade-pricing.ts";
import {
  BUYER_PLAN_ENTITLEMENTS,
  type BuyerAllowances,
  type BuyerFeature,
  type BuyerGateFlags,
  type BuyerPlanKey,
  higherBuyerPlan,
  SELLER_PLAN_BUYER_TIER,
} from "./buyer-plans.ts";

// Subscription statuses that keep a paid plan's entitlements live. `past_due`,
// `paused`, `canceled`, `none` all fall back to Free (deny paid caps).
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export interface BuyerEntitlements {
  plan: BuyerPlanKey;
  gateFlags: BuyerGateFlags;
  allowances: BuyerAllowances;
}

// US-1887: the buyer plan a seller's plan grants on its own (before folding in
// any buyer subscription). Uses effectivePlanFor so a lapsed/paused seller loses
// the bump exactly as they lose seller caps (grace window included).
export interface SellerPlanInput {
  flipdeskPlan?: string | null;
  flipdeskStatus?: string | null;
  trialEndsAt?: string | null;
  pastDueSince?: string | null;
}

function sellerDerivedBuyerTier(seller: SellerPlanInput): BuyerPlanKey {
  const effective = effectivePlanFor(
    seller.flipdeskPlan ?? "free",
    seller.flipdeskStatus ?? null,
    seller.trialEndsAt ?? null,
    undefined,
    seller.pastDueSince ?? null,
  );
  return SELLER_PLAN_BUYER_TIER[effective] ?? "free";
}

/**
 * Pure resolver. Free is the fail-safe floor for any unknown/lapsed input. When
 * `seller` is provided (US-1887), the effective buyer plan is the HIGHER of the
 * buyer subscription and the seller-plan-derived tier, so a seller gets buyer
 * functions without a separate buyer subscription.
 */
export function resolveBuyerEntitlements(
  plan: string | null | undefined,
  status: string | null | undefined,
  seller?: SellerPlanInput,
): BuyerEntitlements {
  const isKnownPaid = plan === "guard" || plan === "connoisseur";
  const buyerSubKey: BuyerPlanKey = isKnownPaid && ACTIVE_STATUSES.has(status ?? "")
    ? plan
    : "free";
  const key = seller
    ? higherBuyerPlan(buyerSubKey, sellerDerivedBuyerTier(seller))
    : buyerSubKey;
  return { plan: key, ...BUYER_PLAN_ENTITLEMENTS[key] };
}

/**
 * The FREE payload, resolved once.
 *
 * US-2503: GET /api/buyer/entitlements answers with this when the users-row read
 * throws, so a database hiccup LOCKS features rather than 500ing or, worse,
 * leaving a client to guess. The fail-safe direction is the whole point: an
 * over-grant shows a paid screen to someone who is not paying.
 */
export const FREE_BUYER_ENTITLEMENTS: BuyerEntitlements = resolveBuyerEntitlements(
  null,
  null,
);

// ── US-1873: unified-extension entitlements (buyer research for everyone, the
// seller Lister on top for PAID FlipDesk accounts) ───────────────────────────
//
// The unified browser extension calls GET /api/grading/public/entitlements with
// its signed extension token to learn which tools to activate. Everyone gets the
// buyer research overlay; the seller Lister unlocks ONLY when the account is on an
// ACTIVE PAID FlipDesk tier — reusing effectivePlanFor so a lapsed / paused /
// expired-trial seller loses it exactly as they lose seller caps (free = floor).

/** FlipDesk tiers that count as "an active seller plan" for the Lister. */
export const PAID_FLIPDESK_PLANS = new Set(["starter", "pro", "business"]);

export interface SellerEntitlement {
  /** True → the account may use the seller Lister tools. */
  sellerEnabled: boolean;
  /** Effective FlipDesk plan ("free" when unset/lapsed/paused/expired). */
  flipdeskPlan: string;
}

/**
 * Pure: does this account's FlipDesk plan unlock the seller Lister? `now` is
 * injectable so the trial/grace-window cases are deterministically testable.
 */
export function resolveSellerEntitlement(
  seller: SellerPlanInput,
  now: Date = new Date(),
): SellerEntitlement {
  const flipdeskPlan = effectivePlanFor(
    seller.flipdeskPlan ?? "free",
    seller.flipdeskStatus ?? null,
    seller.trialEndsAt ?? null,
    now,
    seller.pastDueSince ?? null,
  );
  return { sellerEnabled: PAID_FLIPDESK_PLANS.has(flipdeskPlan), flipdeskPlan };
}

export interface ExtensionEntitlements {
  authenticated: boolean;
  /** Seller Lister gate (paid FlipDesk). */
  sellerEnabled: boolean;
  /** Effective FlipDesk plan. */
  flipdeskPlan: string;
  /** Buyer research tier (everyone gets at least "free"). */
  buyerPlan: BuyerPlanKey;
}

/** Anonymous default — buyer research only, no seller tools. Fail-safe. */
export const ANONYMOUS_EXTENSION_ENTITLEMENTS: ExtensionEntitlements = {
  authenticated: false,
  sellerEnabled: false,
  flipdeskPlan: "free",
  buyerPlan: "free",
};

/**
 * Load the unified-extension entitlements from the caller's OWN users row.
 * `userId` MUST be the id from the verified extension token (never a request-body
 * value) — the read is tenant-scoped by construction (US-268). Falls back to the
 * anonymous default on any read gap so a hiccup never falsely unlocks seller tools.
 */
export async function getExtensionEntitlements(userId: string): Promise<ExtensionEntitlements> {
  const { data } = await supabaseAdmin
    .from("users")
    .select(
      "buyer_plan, buyer_subscription_status, flipdesk_plan, subscription_status, trial_ends_at, past_due_since",
    )
    .eq("id", userId)
    .maybeSingle();
  const row = data as
    | {
      buyer_plan?: string;
      buyer_subscription_status?: string;
      flipdesk_plan?: string;
      subscription_status?: string;
      trial_ends_at?: string | null;
      past_due_since?: string | null;
    }
    | null;
  const seller: SellerPlanInput = {
    flipdeskPlan: row?.flipdesk_plan,
    flipdeskStatus: row?.subscription_status,
    trialEndsAt: row?.trial_ends_at ?? null,
    pastDueSince: row?.past_due_since ?? null,
  };
  const { sellerEnabled, flipdeskPlan } = resolveSellerEntitlement(seller);
  const buyer = resolveBuyerEntitlements(row?.buyer_plan, row?.buyer_subscription_status, seller);
  return { authenticated: true, sellerEnabled, flipdeskPlan, buyerPlan: buyer.plan };
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
    .select(
      "buyer_plan, buyer_subscription_status, flipdesk_plan, subscription_status, trial_ends_at, past_due_since",
    )
    .eq("id", userId)
    .maybeSingle();
  const row = data as
    | {
      buyer_plan?: string;
      buyer_subscription_status?: string;
      flipdesk_plan?: string;
      subscription_status?: string;
      trial_ends_at?: string | null;
      past_due_since?: string | null;
    }
    | null;
  // US-1887: fold the seller plan in — a seller's FlipDesk tier grants buyer
  // functions, so the effective buyer plan is the higher of the two.
  return resolveBuyerEntitlements(row?.buyer_plan, row?.buyer_subscription_status, {
    flipdeskPlan: row?.flipdesk_plan,
    flipdeskStatus: row?.subscription_status,
    trialEndsAt: row?.trial_ends_at ?? null,
    pastDueSince: row?.past_due_since ?? null,
  });
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
