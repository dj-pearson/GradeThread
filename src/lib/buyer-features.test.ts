import { describe, expect, it } from "vitest";
import {
  BUYER_FEATURES,
  type BuyerFeatureFlag,
  buyerFeatureForBullet,
  isBulletComingSoon,
} from "./buyer-features";
import { BUYER_PLANS } from "./constants";

// US-1902: the pricing page must label buyer features whose surface isn't live
// yet. These guard the registry that drives that labeling.

describe("buyer feature registry", () => {
  it("covers exactly the BuyerGateFlags key set (no missing/extra feature)", () => {
    // A plan's gateFlags is the entitlement source of truth; every flag it
    // knows must have shipped-status metadata so nothing is unlabeled.
    const flagKeys = Object.keys(BUYER_PLANS.free.gateFlags).sort();
    const registryKeys = Object.keys(BUYER_FEATURES).sort();
    expect(registryKeys).toEqual(flagKeys);
  });

  it("marks the purchase guarantee as the one not-live buyer surface", () => {
    const notLive = (Object.keys(BUYER_FEATURES) as BuyerFeatureFlag[]).filter(
      (f) => !BUYER_FEATURES[f].live,
    );
    expect(notLive).toEqual(["purchaseGuarantee"]);
  });
});

describe("buyerFeatureForBullet", () => {
  it("maps a guarantee bullet to purchaseGuarantee", () => {
    expect(buyerFeatureForBullet("Standard grade-locked purchase guarantee")).toBe(
      "purchaseGuarantee",
    );
    expect(buyerFeatureForBullet("Plus grade-locked purchase guarantee")).toBe(
      "purchaseGuarantee",
    );
  });
  it("maps live-feature bullets to their flag", () => {
    expect(buyerFeatureForBullet("25 condition alerts (hourly)")).toBe("conditionAlerts");
    expect(buyerFeatureForBullet("Grade-confirmation rewards")).toBe("rewards");
    expect(buyerFeatureForBullet("Track up to 200 closet items")).toBe("wardrobePortfolio");
  });
  it("returns null for allowance/roll-up bullets that describe no single feature", () => {
    expect(buyerFeatureForBullet("Everything in Guard")).toBeNull();
  });
});

describe("isBulletComingSoon", () => {
  it("flags the guarantee bullet, not a live one", () => {
    expect(isBulletComingSoon("Standard grade-locked purchase guarantee")).toBe(true);
    expect(isBulletComingSoon("25 condition alerts (hourly)")).toBe(false);
    expect(isBulletComingSoon("Everything in Guard")).toBe(false);
  });

  it("with ALL buyer features forced not-live, every mapped bullet is coming-soon", () => {
    // AC4: the "all buyer flags off" guard — proves no placeholder-backed
    // bullet can escape the badge as new buyer features are added.
    const allOff = Object.fromEntries(
      (Object.keys(BUYER_FEATURES) as BuyerFeatureFlag[]).map((f) => [f, false]),
    ) as Record<BuyerFeatureFlag, boolean>;
    for (const plan of Object.values(BUYER_PLANS)) {
      for (const bullet of plan.features) {
        const mapped = buyerFeatureForBullet(bullet) != null;
        // Every bullet that maps to a feature must badge when that feature is off.
        expect(isBulletComingSoon(bullet, allOff)).toBe(mapped);
      }
    }
  });
});
