// OM-04: the Offers & Messages hooks. Source guards, because the property is
// the shape of each query (its key, its polling, what a send invalidates) and
// none of it is visible without a network.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/hooks/use-ebay.ts", "utf8").replace(/\r\n/g, "\n");

function hook(name: string): string {
  const at = SRC.indexOf(`export function ${name}(`);
  expect(at, `${name} is gone`).toBeGreaterThan(-1);
  const next = SRC.indexOf("\nexport ", at + 10);
  return SRC.slice(at, next === -1 ? SRC.length : next);
}

describe("negotiation hooks (OM-04)", () => {
  it("the send-today list is tenant-keyed and the discount is not in the key", () => {
    const body = hook("useEbaySendOffersToday");
    expect(body).toMatch(/queryKey: \["ebay_send_offers_today", tenantKey\]/);
    expect(body).not.toMatch(/discount_pct/);
    expect(body).toMatch(/placeholderData: keepPreviousData/);
  });

  it("a send refreshes the ranked list, the eligible list and the analytics", () => {
    const body = hook("useEbaySendOffer");
    for (const key of ["ebay_send_offers_today", "ebay_eligible_offers", "ebay_offer_analytics"]) {
      expect(body).toContain(`invalidateQueries({ queryKey: ["${key}"] })`);
    }
  });

  it("messages poll and refetch on focus", () => {
    const body = hook("useEbayMessages");
    expect(body).toMatch(/queryKey: \["ebay_messages", tenantKey\]/);
    expect(body).toMatch(/refetchInterval: 120_000/);
    expect(body).toMatch(/refetchOnWindowFocus: true/);
    expect(body).toMatch(/staleTime: 60_000/);
  });

  it("every negotiation and messages hook carries the edge's status and code", () => {
    for (const name of [
      "useEbayBestOffers",
      "useEbayRespondOffer",
      "useEbayEligibleOffers",
      "useEbaySendOffer",
      "useEbaySendOffersToday",
      "useEbayThresholdConflicts",
      "useEbayMessages",
      "useEbayReplyMessage",
      "useOfferAnalytics",
    ]) {
      const body = hook(name);
      expect(body, name).toMatch(/throw edgeError\(res, json,/);
      expect(body, name).not.toMatch(/throw new Error\(json\./);
    }
    const helper = SRC.slice(SRC.indexOf("function edgeError("));
    expect(helper.slice(0, 600)).toMatch(/err\.status = res\.status/);
    expect(helper.slice(0, 600)).toMatch(/err\.code = json\.code/);
  });
});
