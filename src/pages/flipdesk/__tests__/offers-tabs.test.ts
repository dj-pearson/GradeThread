import { describe, expect, it } from "vitest";
import {
  DEFAULT_OFFERS_TAB,
  OFFERS_TABS,
  offersTabCounts,
  resolveOffersTabId,
  type OffersTabId,
} from "@/pages/flipdesk/offers-tabs";

describe("offers tabs (US-3297)", () => {
  it("Offers is the default, because it is the only clock eBay runs down for you", () => {
    // A Best Offer expires in hours whether or not the seller looked. A buyer
    // message waits. If one tab has to open first it is this one.
    expect(DEFAULT_OFFERS_TAB).toBe("offers");
    expect(OFFERS_TABS[0]!.id).toBe("offers");
  });

  it("only the two inbox tabs can carry a count", () => {
    // Send is a picker and Insights is a chart of the past. A badge on either
    // would be a number for work that is not waiting on anyone.
    const counted = OFFERS_TABS.filter((t) => t.counted).map((t) => t.id);
    expect(counted).toEqual(["offers", "messages"]);
  });

  it("tab ids are unique and every one has a label", () => {
    const ids = OFFERS_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of OFFERS_TABS) expect(t.label.trim().length).toBeGreaterThan(0);
  });

  describe("resolveOffersTabId", () => {
    it("accepts every real tab id", () => {
      for (const t of OFFERS_TABS) expect(resolveOffersTabId(t.id)).toBe(t.id);
    });

    it("resolves the names used in help copy and saved links", () => {
      // The failure this pins: a link written against the stacked page landing
      // on the default tab instead of on the section it named.
      const cases: [string, OffersTabId][] = [
        ["best-offers", "offers"],
        ["buyer-messages", "messages"],
        ["inbox", "messages"],
        ["send-offers", "send"],
        ["watchers", "send"],
        ["offer-analytics", "insights"],
        ["analytics", "insights"],
      ];
      for (const [raw, expected] of cases) {
        expect(resolveOffersTabId(raw)).toBe(expected);
      }
    });

    it("tolerates a leading hash, surrounding space and odd casing", () => {
      expect(resolveOffersTabId("#Best-Offers")).toBe("offers");
      expect(resolveOffersTabId("  MESSAGES ")).toBe("messages");
    });

    it("returns null for anything it does not know, so the caller picks the default", () => {
      for (const raw of [null, undefined, "", "   ", "shipping", "../../etc"]) {
        expect(resolveOffersTabId(raw)).toBeNull();
      }
    });
  });

  describe("offersTabCounts", () => {
    it("puts each inbox count on its own tab and leaves the rest at zero", () => {
      const counts = offersTabCounts({ openOffers: 4, unansweredMessages: 9 });
      expect(counts).toEqual({
        offers: 4,
        messages: 9,
        send: 0,
        insights: 0,
      });
    });

    it("covers every tab, so a new tab cannot read undefined", () => {
      const counts = offersTabCounts({ openOffers: 0, unansweredMessages: 0 });
      for (const t of OFFERS_TABS) expect(counts[t.id]).toBe(0);
    });
  });
});
