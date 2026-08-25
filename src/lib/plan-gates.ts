import {
  FLIPDESK_PLANS,
  type FlipdeskPlanKey,
  type FlipdeskGateFlags,
} from "@/lib/constants";

// US-2872. A hidden feature cannot be wanted.
//
// THE STORY READS AS A SWEEP AND IS ACTUALLY ONE ENTRY. Measured before
// building: sidebar.tsx has exactly ONE nav item with `requiresFlipdeskFlag`
// (AutoLister) out of ten gate flags, and of the four in-page plan gates,
// three already explain themselves properly -- api-keys.tsx renders a full
// upgrade card, radar.tsx has NetworkUpgradeCard, reconciliation.tsx carries a
// lock badge naming the plan. The single silent one is AutoLister's Generate
// button, which is `disabled={... || !entitled}` with no reason given.
//
// So this module is small on purpose. It exists so the locked nav entry, the
// disabled button and any future gate all answer the same two questions from
// one place: what does this do, and which plan has it.

/** The FlipDesk tiers, cheapest first. Upgrade paths walk this order. */
export const PLAN_ORDER: readonly FlipdeskPlanKey[] = [
  "free",
  "starter",
  "pro",
  "business",
];

export function planIncludesFlag(
  plan: FlipdeskPlanKey,
  flag: keyof FlipdeskGateFlags,
): boolean {
  return FLIPDESK_PLANS[plan].gateFlags[flag] === true;
}

/**
 * The cheapest plan that carries `flag`, or null if no plan does.
 *
 * DERIVED, never written down. A hardcoded "Pro" in an upgrade prompt is a
 * promise that goes stale the day a flag moves tier, and it would go stale
 * silently -- the prompt still renders, just pointing at the wrong plan.
 */
export function requiredPlanForFlag(
  flag: keyof FlipdeskGateFlags,
): FlipdeskPlanKey | null {
  return PLAN_ORDER.find((p) => planIncludesFlag(p, flag)) ?? null;
}

/** "Pro", "Business". The name a seller sees on the pricing page. */
export function planLabel(plan: FlipdeskPlanKey): string {
  return FLIPDESK_PLANS[plan].name;
}

/**
 * One plain sentence per gated feature: what it DOES, not what it costs.
 *
 * An upsell that only says "upgrade for AutoLister" is the hidden-feature
 * problem wearing a lock icon -- the seller still does not know what they are
 * being sold. Every flag that can reach a user gets a sentence.
 */
export const GATE_FEATURE_COPY: Record<keyof FlipdeskGateFlags, string> = {
  autolister:
    "Drop in a pile of photos and get a written, priced draft listing for every item at once.",
  bulkActions:
    "Change the price, quantity or status of many listings in one go instead of one at a time.",
  scheduledActions:
    "Queue listings to go live later, at the hour buyers are actually looking.",
  compPulls:
    "See what items like yours actually sold for, so you price from evidence.",
  autoRelist: "Put an unsold listing back up on its own, without you remembering.",
  subAccounts: "Give someone else a login of their own, with only the access you choose.",
  apiAccess: "Send items to GradeThread from your own software instead of by hand.",
  connectorAccess: "Link the other places you sell, so stock and orders stay in step.",
  reconciliation:
    "Match what the marketplace paid you against what you sold, and see the fees in between.",
  prioritySupport: "Your support messages go to the front of the queue.",
};

/** Everything a locked surface needs to explain itself, or null when ungated. */
export interface GateExplanation {
  flag: keyof FlipdeskGateFlags;
  /** What the feature does, one sentence. */
  what: string;
  /** The cheapest plan that has it. */
  requiredPlan: FlipdeskPlanKey;
  requiredPlanLabel: string;
}

export function explainGate(
  flag: keyof FlipdeskGateFlags,
): GateExplanation | null {
  const requiredPlan = requiredPlanForFlag(flag);
  if (!requiredPlan) return null;
  return {
    flag,
    what: GATE_FEATURE_COPY[flag],
    requiredPlan,
    requiredPlanLabel: planLabel(requiredPlan),
  };
}
