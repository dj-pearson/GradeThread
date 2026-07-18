import type { BuyerGateFlags } from "@/lib/constants";

// US-1902: single source of truth for whether each buyer-suite feature's SURFACE
// is live yet, so the pricing page can't sell a feature that still lands on a
// placeholder. `live` mirrors the /buyer/* route table (src/routes/index.tsx):
// a route that renders BuyerPlaceholderPage is NOT live. Keep this in lockstep
// with that table — the guard test (buyer-features.test.ts) + the pricing render
// test fail if a placeholder-backed feature is sold without a "Coming soon"
// badge. Entitlement (which PLAN unlocks a feature) is separate — that's
// BuyerGateFlags on the plan; this is purely shipped-vs-planned.

export interface BuyerFeatureMeta {
  /** Short human label for the feature. */
  label: string;
  /** Is the feature's buyer surface shipped (not a placeholder)? */
  live: boolean;
  /** Does a curated plan-feature bullet describe THIS feature? Used to badge the
   *  right bullet on the pricing page without a hand-maintained duplicate list. */
  match: (bullet: string) => boolean;
}

// Keyed by the BuyerGateFlags flag so the registry can never list a feature the
// entitlement model doesn't know about (TS enforces the full key set).
export const BUYER_FEATURES: Record<keyof BuyerGateFlags, BuyerFeatureMeta> = {
  extensionSecondOpinion: {
    label: "Extension second-opinion checks",
    live: true,
    match: (b) => /second[- ]opinion/i.test(b),
  },
  discrepancyScoring: {
    label: "Claimed-vs-objective discrepancy",
    live: true,
    match: (b) => /discrepancy/i.test(b),
  },
  priceFairness: {
    label: "Price-fairness meter",
    live: true,
    match: (b) => /price[- ]fairness/i.test(b),
  },
  conditionAlerts: {
    label: "Condition alerts",
    live: true,
    match: (b) => /condition alert|\balerts?\b/i.test(b),
  },
  fitPrediction: {
    label: "Fit prediction",
    live: true,
    match: (b) => /fit prediction/i.test(b),
  },
  authenticityAddon: {
    label: "Authenticity add-on",
    live: true,
    match: (b) => /authenticity/i.test(b),
  },
  videoGrading: {
    label: "Walk-around video grading",
    live: true,
    match: (b) => /video[- ]grad/i.test(b),
  },
  rewards: {
    label: "Grade-confirmation rewards",
    live: true,
    match: (b) => /rewards?/i.test(b),
  },
  trustScore: {
    label: "Buyer trust score",
    live: true,
    match: (b) => /trust score/i.test(b),
  },
  // The only buyer surface still behind BuyerPlaceholderPage (/buyer/guarantee).
  purchaseGuarantee: {
    label: "Grade-locked purchase guarantee",
    // US-2073: now LIVE — /buyer/guarantee renders the real coverage surface
    // (covered purchases with window + payout cap + trigger threshold, claim
    // status, and WHY anything is excluded) instead of a placeholder. This flag
    // drives the "Coming soon" badge on the public pricing page, so leaving it
    // false would keep advertising a shipped feature as unshipped.
    live: true,
    match: (b) => /guarantee|purchase protection/i.test(b),
  },
  wardrobePortfolio: {
    label: "Wardrobe portfolio",
    live: true,
    match: (b) => /closet|portfolio/i.test(b),
  },
  demandBoard: {
    label: "Graded-Wanted demand board",
    live: true,
    match: (b) => /demand board|graded[- ]wanted/i.test(b),
  },
  prioritySupport: {
    label: "Priority support",
    live: true,
    match: (b) => /priority support/i.test(b),
  },
};

export type BuyerFeatureFlag = keyof BuyerGateFlags;

/** The buyer feature a curated bullet describes, or null if it maps to none
 *  (e.g. "Everything in Guard", allowance-only lines). First match wins. */
export function buyerFeatureForBullet(
  bullet: string,
): BuyerFeatureFlag | null {
  for (const flag of Object.keys(BUYER_FEATURES) as BuyerFeatureFlag[]) {
    if (BUYER_FEATURES[flag].match(bullet)) return flag;
  }
  return null;
}

/**
 * Is this plan-feature bullet describing a not-yet-live feature? `liveOverride`
 * lets the test force every feature planned ("all buyer flags off") to prove no
 * placeholder-backed bullet can escape the badge as features are added.
 */
export function isBulletComingSoon(
  bullet: string,
  liveOverride?: Partial<Record<BuyerFeatureFlag, boolean>>,
): boolean {
  const flag = buyerFeatureForBullet(bullet);
  if (!flag) return false;
  const live = liveOverride?.[flag] ?? BUYER_FEATURES[flag].live;
  return !live;
}
