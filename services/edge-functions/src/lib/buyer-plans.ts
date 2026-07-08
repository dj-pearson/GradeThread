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

export interface BuyerAllowances {
  /** -1 = unlimited. */
  extensionChecksPerMonth: number;
  authenticityCreditsPerMonth: number;
  videoGradeCreditsPerMonth: number;
  activeAlertsCap: number;
  portfolioItemCap: number;
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
    },
  },
};
