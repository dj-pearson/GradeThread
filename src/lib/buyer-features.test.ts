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

  it("every registry entry has an explicit live flag", () => {
    // US-2073: this used to assert notLive === ["purchaseGuarantee"] — a
    // SNAPSHOT of which feature happened to be unshipped. Shipping the
    // guarantee coverage surface then failed the test for the right reason but
    // the wrong shape, and the fix would have been to swap in the NEXT
    // unshipped feature's name, which just relocates the problem.
    //
    // What actually needs protecting is that every feature declares its status
    // (the "no unlabeled surface" invariant asserted above), not which
    // particular one is pending. isBulletComingSoon's behaviour is covered
    // below, including the all-off case.
    for (const f of Object.keys(BUYER_FEATURES) as BuyerFeatureFlag[]) {
      expect(
        typeof BUYER_FEATURES[f].live,
        `${f} must declare live:boolean so the pricing page can badge it`,
      ).toBe("boolean");
    }
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
  it("mirrors each feature's live flag, and ignores non-feature bullets", () => {
    // US-2073: was hardcoded to "guarantee bullet => true". The guarantee is
    // live now, so assert the RULE instead: a bullet is coming-soon exactly
    // when the feature it maps to is not live.
    const guaranteeBullet = "Standard grade-locked purchase guarantee";
    expect(isBulletComingSoon(guaranteeBullet)).toBe(
      !BUYER_FEATURES.purchaseGuarantee.live,
    );
    const alertsBullet = "25 condition alerts (hourly)";
    expect(isBulletComingSoon(alertsBullet)).toBe(
      !BUYER_FEATURES.conditionAlerts.live,
    );
    // A bullet that maps to no feature is never badged, whatever ships.
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
