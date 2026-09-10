// US-3223. The quote id and rate id a rate-shop leaves in state are exactly
// what "Buy label" sends to eBay, so a stale rate-shop buys postage for a parcel
// that is not the one on screen.
import { describe, expect, it } from "vitest";

import { createRunOwner } from "@/lib/latest-run";
import {
  acceptRateQuote,
  cheapestPricedRate,
} from "@/components/flipdesk/ship-rate-quote";
import type { EbayShippingQuote, EbayShippingRate } from "@/hooks/use-ebay";

function rate(
  rateId: string,
  totalCostCents: number | null,
): EbayShippingRate {
  return {
    rateId,
    carrier: "USPS",
    serviceName: "Ground Advantage",
    totalCostCents,
    currency: "USD",
    minDeliveryDate: null,
    maxDeliveryDate: null,
    additionalOptions: [],
  };
}

function quote(id: string, rates: EbayShippingRate[]): EbayShippingQuote {
  return { shippingQuoteId: id, expiresAt: null, rates };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("cheapestPricedRate", () => {
  it("picks the lowest total among the rates that carry a price", () => {
    const picked = cheapestPricedRate([
      rate("a", 1299),
      rate("b", 799),
      rate("c", 1050),
    ]);
    expect(picked?.rateId).toBe("b");
  });

  it("never preselects a rate eBay quoted without a price", () => {
    const picked = cheapestPricedRate([rate("unpriced", null), rate("b", 1500)]);
    expect(picked?.rateId).toBe("b");
  });

  it("returns null when nothing has a price", () => {
    expect(cheapestPricedRate([rate("x", null)])).toBeNull();
  });

  it("returns null for an empty rate list", () => {
    expect(cheapestPricedRate([])).toBeNull();
  });
});

describe("acceptRateQuote", () => {
  it("returns the quote id, the rates and the preselection", () => {
    const owner = createRunOwner();
    const patch = acceptRateQuote(
      owner.begin(),
      quote("quote-5lb", [rate("a", 2200), rate("b", 1800)]),
    );
    expect(patch).toEqual({
      quoteId: "quote-5lb",
      rateOptions: [rate("a", 2200), rate("b", 1800)],
      selectedRateId: "b",
    });
  });

  it("refuses a quote whose run was superseded", () => {
    const owner = createRunOwner();
    const stale = owner.begin();
    owner.begin();
    expect(acceptRateQuote(stale, quote("q", [rate("a", 100)]))).toBeNull();
  });
});

describe("two rate-shops racing", () => {
  // "Get rates" is disabled only while the RATE mutation is pending. fetchRates
  // looks the sale up first, and the button is live for that whole round trip:
  // type 1 lb, click, change to 5 lb, click again. Before the guard the 1 lb
  // quote could land last, leaving 1 lb rates and a 1 lb quote id under a box
  // reading 5 lb -- and Buy pays for the wrong parcel.
  it("keeps the newer weight's quote when the older one lands last", async () => {
    const owner = createRunOwner();
    const oneLb = deferred<EbayShippingQuote>();
    const fiveLb = deferred<EbayShippingQuote>();

    let armed: { quoteId: string; selectedRateId: string | null } | null = null;

    const firstRun = owner.begin();
    const firstPending = oneLb.promise.then((q) => {
      const patch = acceptRateQuote(firstRun, q);
      if (patch) armed = { quoteId: patch.quoteId, selectedRateId: patch.selectedRateId };
    });

    const secondRun = owner.begin();
    const secondPending = fiveLb.promise.then((q) => {
      const patch = acceptRateQuote(secondRun, q);
      if (patch) armed = { quoteId: patch.quoteId, selectedRateId: patch.selectedRateId };
    });

    fiveLb.resolve(quote("quote-5lb", [rate("five-cheap", 2400)]));
    await secondPending;
    oneLb.resolve(quote("quote-1lb", [rate("one-cheap", 699)]));
    await firstPending;

    expect(armed).toEqual({ quoteId: "quote-5lb", selectedRateId: "five-cheap" });
  });

  // Reopening the dialog on a different order supersedes without starting a
  // replacement, so an in-flight quote for the previous order cannot re-arm Buy.
  it("drops a quote for an order the dialog has moved off", async () => {
    const owner = createRunOwner();
    const previousOrder = deferred<EbayShippingQuote>();
    let armed: string | null = null;

    const run = owner.begin();
    const pending = previousOrder.promise.then((q) => {
      const patch = acceptRateQuote(run, q);
      if (patch) armed = patch.quoteId;
    });

    owner.supersede(); // the dialog reset onto another item

    previousOrder.resolve(quote("quote-other-order", [rate("a", 500)]));
    await pending;

    expect(armed).toBeNull();
  });
});
