import { describe, expect, it } from "vitest";
import { blockerTarget, COMPOSER_FOCUS_ANCHORS } from "./publish-blockers";

const ITEM = "item-123";

describe("blockerTarget", () => {
  it("routes the category blocker to the composer category field", () => {
    const t = blockerTarget("Pick an eBay category.", ITEM);
    expect(t.to).toBe(`/dashboard/flipdesk/items/${ITEM}/draft?focus=category`);
  });

  it("routes a specifics blocker to the specifics focus (even when it mentions category)", () => {
    const t = blockerTarget(
      "Could not load eBay specifics for this category. Try again.",
      ITEM,
    );
    expect(t.to).toBe(`/dashboard/flipdesk/items/${ITEM}/draft?focus=specifics`);
  });

  it("routes required-specifics blocker to specifics", () => {
    const t = blockerTarget(
      "Fill required eBay specifics in the composer: Brand, Size",
      ITEM,
    );
    expect(t.to).toContain("focus=specifics");
  });

  it("routes the photo blockers to photos", () => {
    expect(blockerTarget("Add at least one photo.", ITEM).to).toContain(
      "focus=photos",
    );
    expect(
      blockerTarget("The size for ImageLinks cannot exceed 24 pictures.", ITEM)
        .to,
    ).toContain("focus=photos");
  });

  it("routes the price blocker to price", () => {
    expect(blockerTarget("Set a target price.", ITEM).to).toContain(
      "focus=price",
    );
  });

  it("routes the title blocker to title", () => {
    expect(blockerTarget("Set a title.", ITEM).to).toContain("focus=title");
  });

  it("routes account-level blockers to Marketplaces", () => {
    expect(
      blockerTarget(
        "Configure eBay business policies on your seller account: shipping.",
        ITEM,
      ).to,
    ).toBe("/dashboard/flipdesk/marketplaces");
    expect(
      blockerTarget(
        "Set your eBay ship-from location: open FlipDesk → Marketplaces.",
        ITEM,
      ).to,
    ).toBe("/dashboard/flipdesk/marketplaces");
    expect(
      blockerTarget(
        "Your eBay connection needs to be refreshed. Disconnect and reconnect.",
        ITEM,
      ).to,
    ).toBe("/dashboard/flipdesk/marketplaces");
  });

  it("falls back to the composer with no focus for unknown blockers", () => {
    const t = blockerTarget("Something unexpected happened.", ITEM);
    expect(t.to).toBe(`/dashboard/flipdesk/items/${ITEM}/draft`);
  });

  it("every composer focus field maps to a DOM anchor id", () => {
    for (const field of ["title", "category", "specifics", "photos", "price", "condition"]) {
      expect(COMPOSER_FOCUS_ANCHORS[field]).toBeTruthy();
    }
  });
});
