import { describe, expect, it } from "vitest";
import {
  describeSendResult,
  discountExposureCents,
  discountedPriceLabel,
  efficientDiscountPct,
  sendConfirmCopy,
} from "@/pages/flipdesk/send-offer-result";

describe("send-offer arithmetic and wording (OM-12)", () => {
  it("totals the exposure, or refuses to when a price is missing", () => {
    expect(discountExposureCents([5000, 3000], 10)).toBe(800);
    expect(discountExposureCents([5000, null], 10)).toBeNull();
  });

  it("pluralizes the confirm and names the figure", () => {
    expect(sendConfirmCopy(1, 12, 600).title).toBe("Send 12% off to 1 listing?");
    expect(sendConfirmCopy(4, 12, 600, "item").title).toBe("Send 12% off to 4 items?");
    expect(sendConfirmCopy(4, 12, 600).description).toContain("$6.00");
    expect(sendConfirmCopy(4, 12, null).description).toContain("no price on record");
  });

  it("reports a partial send and keeps the failures", () => {
    const out = describeSendResult(
      { ok: false, count: 3, sent: ["a", "b", "c"], failed: [{ ids: ["d"], detail: "Not eligible." }] },
      4,
    );
    expect(out.partial).toBe(true);
    expect(out.failedIds).toEqual(["d"]);
    expect(out.summary).toBe(
      "Sent to 3 of 4 listings. eBay did not take the rest, so they are still selected. Try them again.",
    );
    // Our sentence only: the edge's detail is not echoed into a toast (US-2869).
    expect(out.summary).not.toContain("Not eligible.");
    expect(describeSendResult({ ok: true, count: 1 }, 1).summary).toBe("Offer sent on 1 listing.");
  });

  it("labels the price before and after", () => {
    expect(discountedPriceLabel(5000, 10)).toBe("$50.00 -> $45.00");
    expect(discountedPriceLabel(null, 10)).toBeNull();
    expect(discountedPriceLabel(5000, null)).toBeNull();
  });

  it("turns the Insights efficient depth into a discount the Send tab takes", () => {
    const curve = {
      buckets: [{ key: "10-15% off", fromPct: 10, offers: 20, accepted: 8, acceptRate: 0.4, medianDaysToAccept: 1 }],
      efficientDepth: { key: "10-15% off", acceptRate: 0.4, bestKey: "20-25% off", bestAcceptRate: 0.41, explanation: "" },
      totalOffers: 20,
      minBucketSample: 5,
    };
    expect(efficientDiscountPct(curve as never)).toBe(10);
    expect(efficientDiscountPct({ ...curve, efficientDepth: null } as never)).toBeNull();
    expect(
      efficientDiscountPct({
        ...curve,
        efficientDepth: { ...curve.efficientDepth, key: "under 5% off", fromPct: 0 },
      } as never),
    ).toBeNull();
  });
});
