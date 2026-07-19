// US-2105 AC4: Product/Offer on /pricing.
//
// Product markup existed only on cert/passport/value SSR — everywhere except
// the page where someone decides to buy. But adding commercial markup creates
// an obligation the FAQPage did not: a price in structured data is rendered in
// search results, cached by engines we do not control, and read as a
// commitment.
//
// That is the US-2123 defect (advertised entitlement ≠ granted entitlement) on
// a surface with a worse blast radius. So the assertion that matters is not
// "Product exists" — it is that every advertised figure is DERIVED from
// FLIPDESK_PLANS rather than restated beside it.

import { describe, expect, it } from "vitest";
import { pricingOfferLd, pricingJsonLd } from "@/pages/marketing/marketing-jsonld";
import { FLIPDESK_PLANS } from "@/lib/constants";

const offer = pricingOfferLd() as unknown as {
  "@type": string;
  offers: Array<{
    name: string;
    price: string;
    priceCurrency: string;
    priceSpecification: { price: string; unitCode: string };
  }>;
};

const paidPlans = (Object.keys(FLIPDESK_PLANS) as Array<keyof typeof FLIPDESK_PLANS>)
  .map((k) => FLIPDESK_PLANS[k])
  .filter((p) => p.priceMonthlyCents > 0);

describe("US-2105 AC4: /pricing ships Product/Offer", () => {
  it("is a Product carrying one Offer per paid plan", () => {
    expect(offer["@type"]).toBe("Product");
    expect(offer.offers.length).toBe(paidPlans.length);
    expect(offer.offers.length).toBeGreaterThan(0);
  });

  it("every advertised price matches FLIPDESK_PLANS exactly", () => {
    // The guard that matters. If a plan is repriced and this drifts, search
    // results advertise a price we no longer charge — and we cannot invalidate
    // the engine's cache.
    for (const plan of paidPlans) {
      const expected = (plan.priceMonthlyCents / 100).toFixed(2);
      const match = offer.offers.find((o) => o.name.startsWith(plan.name));
      expect(match, `no Offer for plan "${plan.name}"`).toBeTruthy();
      expect(
        match!.price,
        `Offer for ${plan.name} advertises ${match!.price} but FLIPDESK_PLANS ` +
          `charges ${expected}`,
      ).toBe(expected);
      expect(match!.priceSpecification.price).toBe(expected);
    }
  });

  it("states the billing period, so a subscription cannot read as one-off", () => {
    for (const o of offer.offers) {
      expect(o.priceSpecification.unitCode).toBe("MON");
      expect(o.priceCurrency).toBe("USD");
    }
  });

  it("excludes the free plan", () => {
    // An Offer at 0 competes with the paid tiers in rich results for no gain.
    expect(offer.offers.some((o) => o.price === "0.00")).toBe(false);
    expect(offer.offers.some((o) => o.name.startsWith("Free"))).toBe(false);
  });

  it("keeps the existing FAQPage alongside it", () => {
    const types = pricingJsonLd().map((n) => (n as { "@type"?: string })["@type"]);
    expect(types).toContain("Product");
    expect(types).toContain("FAQPage");
  });

  it("BOTH types survive the prerender path, not just the declared one", async () => {
    // /pricing declared jsonLdType "FAQPage" before this change and now declares
    // "Product" — a route carries only one. That would silently drop FAQPage's
    // US-2044 prerender guarantee, so this asserts the property directly
    // against jsonLdForRoute(), which is what the prerenderer actually calls.
    const { jsonLdForRoute } = await import("@/../src/prerender/head-builder");
    const emitted = jsonLdForRoute("/pricing") ?? [];
    const types = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      const t = (node as { "@type"?: unknown })["@type"];
      if (typeof t === "string") types.add(t);
      Object.values(node as Record<string, unknown>).forEach(walk);
    };
    walk(emitted);
    expect(types.has("Product"), "Product missing from prerendered /pricing").toBe(true);
    expect(types.has("FAQPage"), "FAQPage lost its prerender guarantee").toBe(true);
    expect(types.has("Offer")).toBe(true);
  });
});
