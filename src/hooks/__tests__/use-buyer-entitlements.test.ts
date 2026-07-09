import { describe, it, expect } from "vitest";
import {
  resolveBuyerPlanKey,
  sellerDerivedBuyerPlanKey,
} from "@/hooks/use-buyer-entitlements";
import { higherBuyerPlan, SELLER_PLAN_BUYER_TIER } from "@/lib/constants";

// US-1887: seller plans bundle tier-matched buyer functions. These pure
// resolvers must agree with the edge (buyer-entitlements.ts) in lockstep.

describe("resolveBuyerPlanKey (buyer subscription)", () => {
  it("grants a paid tier only when active/trialing", () => {
    expect(resolveBuyerPlanKey("guard", "active")).toBe("guard");
    expect(resolveBuyerPlanKey("connoisseur", "trialing")).toBe("connoisseur");
    expect(resolveBuyerPlanKey("guard", "past_due")).toBe("free");
    expect(resolveBuyerPlanKey("connoisseur", "canceled")).toBe("free");
    expect(resolveBuyerPlanKey(null, null)).toBe("free");
    expect(resolveBuyerPlanKey("enterprise", "active")).toBe("free");
  });
});

describe("sellerDerivedBuyerPlanKey (seller plan → buyer tier)", () => {
  it("maps active seller tiers to their buyer tier", () => {
    expect(sellerDerivedBuyerPlanKey("business", "active")).toBe("connoisseur");
    expect(sellerDerivedBuyerPlanKey("pro", "active")).toBe("guard");
    expect(sellerDerivedBuyerPlanKey("starter", "active")).toBe("guard");
    expect(sellerDerivedBuyerPlanKey("free", "none")).toBe("free");
  });

  it("drops the bump when the seller subscription is not active/trialing", () => {
    expect(sellerDerivedBuyerPlanKey("business", "canceled")).toBe("free");
    expect(sellerDerivedBuyerPlanKey("pro", "paused")).toBe("free");
  });

  it("matches the mapping table exactly for active tiers", () => {
    for (const [flip, buyer] of Object.entries(SELLER_PLAN_BUYER_TIER)) {
      const status = flip === "free" ? "none" : "active";
      expect(sellerDerivedBuyerPlanKey(flip, status)).toBe(buyer);
    }
  });
});

describe("higherBuyerPlan (effective = max of the two)", () => {
  it("picks the higher-ranked plan", () => {
    expect(higherBuyerPlan("free", "connoisseur")).toBe("connoisseur");
    expect(higherBuyerPlan("guard", "free")).toBe("guard");
    expect(higherBuyerPlan("guard", "connoisseur")).toBe("connoisseur");
    expect(higherBuyerPlan("free", "free")).toBe("free");
  });
});
