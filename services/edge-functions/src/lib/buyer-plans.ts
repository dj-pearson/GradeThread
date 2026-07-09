// US-1799/1800: buyer-plan entitlement matrix — EDGE mirror.
//
// The canonical, marketing-facing copy lives in src/lib/constants.ts
// (BUYER_PLANS, frontend). This is the edge-side (Deno) mirror that
// buyer-entitlements.ts uses to gate routes and meter monthly allowances. It
// carries only what the edge gate needs — the boolean feature flags and the
// numeric allowances, not the marketing `features[]` copy. Keep the flag names
// and allowance keys in LOCKSTEP with constants.ts (they are referenced across
// the buyer feature epics US-1805…1844; renaming one side silently un-gates a
// feature).

export type BuyerPlanKey = "free" | "guard" | "connoisseur";

// US-1887: seller (FlipDesk) plans INCLUDE tier-matched buyer functions. A
// seller's effective buyer plan is the HIGHER of their buyer subscription and
// this seller-derived tier, so a seller never needs a separate buyer sub. Keyed
// by FlipdeskPlanKey (free/starter/pro/business); an unknown key → free.
// LOCKSTEP with SELLER_PLAN_BUYER_TIER in src/lib/constants.ts.
export const SELLER_PLAN_BUYER_TIER: Record<string, BuyerPlanKey> = {
  free: "free",
  starter: "guard",
  pro: "guard",
  business: "connoisseur",
};

export const BUYER_PLAN_RANK: Record<BuyerPlanKey, number> = {
  free: 0,
  guard: 1,
  connoisseur: 2,
};

/** The higher-ranked of two buyer plans (Connoisseur > Guard > Free). */
export function higherBuyerPlan(a: BuyerPlanKey, b: BuyerPlanKey): BuyerPlanKey {
  return BUYER_PLAN_RANK[a] >= BUYER_PLAN_RANK[b] ? a : b;
}

export interface BuyerGateFlags {
  extensionSecondOpinion: boolean;
  discrepancyScoring: boolean;
  priceFairness: boolean;
  conditionAlerts: boolean;
  fitPrediction: boolean;
  authenticityAddon: boolean;
  videoGrading: boolean;
  rewards: boolean;
  trustScore: boolean;
  purchaseGuarantee: boolean;
  wardrobePortfolio: boolean;
  demandBoard: boolean;
  prioritySupport: boolean;
}

export type BuyerFeature = keyof BuyerGateFlags;

// US-1803: the fastest notification cadence a tier may receive. Free is batched
// to at most a daily digest; guard may get near-real-time; connoisseur is
// instant. LOCKSTEP with BuyerAlertFrequency in src/lib/constants.ts.
export type BuyerAlertFrequency = "daily" | "hourly" | "instant";

export interface BuyerAllowances {
  /** -1 = unlimited. */
  extensionChecksPerMonth: number;
  authenticityCreditsPerMonth: number;
  videoGradeCreditsPerMonth: number;
  activeAlertsCap: number;
  portfolioItemCap: number;
  /** US-1803: fastest cadence this tier may receive (the digest cap). */
  alertFrequency: BuyerAlertFrequency;
}

// The buyer's chosen delivery cadence (buyer_preferences.digest_frequency).
export type BuyerDigestFrequency = "immediate" | "daily" | "weekly";

/**
 * US-1803: the effective delivery mode = the buyer's chosen cadence, floored by
 * their plan's cap. A Free buyer (cap 'daily') who chose 'immediate' is batched
 * to 'daily'; connoisseur ('instant') honors 'immediate'. Pure + tested.
 */
export function effectiveDigestMode(
  chosen: BuyerDigestFrequency,
  cap: BuyerAlertFrequency,
): BuyerDigestFrequency {
  // Immediate push/email is only allowed when the plan cap permits real-time
  // delivery (instant or hourly). A daily-capped plan never sends immediately.
  const planAllowsImmediate = cap === "instant" || cap === "hourly";
  if (chosen === "immediate" && !planAllowsImmediate) return "daily";
  return chosen;
}

/** A metered buyer resource — the keys of BuyerAllowances that debit per use. */
export type BuyerMeter =
  | "extensionChecksPerMonth"
  | "authenticityCreditsPerMonth"
  | "videoGradeCreditsPerMonth";

export interface BuyerPlanEntitlement {
  gateFlags: BuyerGateFlags;
  allowances: BuyerAllowances;
}

export const BUYER_PLAN_ENTITLEMENTS: Record<BuyerPlanKey, BuyerPlanEntitlement> = {
  free: {
    gateFlags: {
      extensionSecondOpinion: true,
      discrepancyScoring: false,
      priceFairness: false,
      conditionAlerts: true,
      fitPrediction: false,
      authenticityAddon: false,
      videoGrading: false,
      rewards: true,
      trustScore: true,
      purchaseGuarantee: false,
      wardrobePortfolio: true,
      demandBoard: false,
      prioritySupport: false,
    },
    allowances: {
      extensionChecksPerMonth: 10,
      authenticityCreditsPerMonth: 0,
      videoGradeCreditsPerMonth: 0,
      activeAlertsCap: 3,
      portfolioItemCap: 10,
      alertFrequency: "daily",
    },
  },
  guard: {
    gateFlags: {
      extensionSecondOpinion: true,
      discrepancyScoring: true,
      priceFairness: true,
      conditionAlerts: true,
      fitPrediction: true,
      authenticityAddon: true,
      videoGrading: true,
      rewards: true,
      trustScore: true,
      purchaseGuarantee: true,
      wardrobePortfolio: true,
      demandBoard: false,
      prioritySupport: false,
    },
    allowances: {
      extensionChecksPerMonth: -1,
      authenticityCreditsPerMonth: 3,
      videoGradeCreditsPerMonth: 2,
      activeAlertsCap: 25,
      portfolioItemCap: 200,
      alertFrequency: "hourly",
    },
  },
  connoisseur: {
    gateFlags: {
      extensionSecondOpinion: true,
      discrepancyScoring: true,
      priceFairness: true,
      conditionAlerts: true,
      fitPrediction: true,
      authenticityAddon: true,
      videoGrading: true,
      rewards: true,
      trustScore: true,
      purchaseGuarantee: true,
      wardrobePortfolio: true,
      demandBoard: true,
      prioritySupport: true,
    },
    allowances: {
      extensionChecksPerMonth: -1,
      authenticityCreditsPerMonth: 15,
      videoGradeCreditsPerMonth: 10,
      activeAlertsCap: -1,
      portfolioItemCap: -1,
      alertFrequency: "instant",
    },
  },
};
