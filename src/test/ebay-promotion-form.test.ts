// US-1979 (AC2): the promotion form's pre-check must agree with eBay's real rules.
//
// The edge validates by RUNNING buildItemPromotionBody (eBay's own body-builder),
// so it is the authority. The form pre-checks the same rules purely so the seller
// sees the problem beside the field instead of via a round trip.
//
// Two copies, therefore two failure modes, and both are quiet:
//   • form TOO STRICT  → a valid promotion is blocked with a message eBay would
//     never have sent, and the seller has no way to tell it's our bug.
//   • form TOO LOOSE   → the seller's fixable mistake is submitted, and comes back
//     as an opaque "eBay rejected the promotion" instead of "your coupon code is
//     too short".
//
// So this pins the rules that ARE shared, per type, in both directions.

import { describe, it, expect } from "vitest";
import {
  promotionFormProblem,
  type PromotionFormState,
} from "@/components/flipdesk/ebay-promotion-dialog";

const IMG = "https://i.ebayimg.com/promo.jpg";

const valid = (over: Partial<PromotionFormState> = {}): PromotionFormState => ({
  type: "ORDER_DISCOUNT",
  name: "Spring sale",
  selectedCount: 1,
  percentOff: "20",
  minSpend: "50.00",
  buyQuantity: "2",
  couponCode: "FDABCDEFGH",
  imageUrl: IMG,
  ...over,
});

describe("US-1979: promotion form pre-check", () => {
  it("accepts a valid promotion of each type", () => {
    expect(promotionFormProblem(valid({ type: "ORDER_DISCOUNT" }))).toBeNull();
    // VOLUME_DISCOUNT is the one type eBay requires NO banner image for. A form
    // that demanded one uniformly would block a promotion eBay accepts.
    expect(
      promotionFormProblem(valid({ type: "VOLUME_DISCOUNT", imageUrl: "" })),
    ).toBeNull();
    expect(promotionFormProblem(valid({ type: "CODED_COUPON" }))).toBeNull();
  });

  it("requires a name and at least one listing, whatever the type", () => {
    expect(promotionFormProblem(valid({ name: "   " }))).toMatch(/name/i);
    expect(promotionFormProblem(valid({ selectedCount: 0 }))).toMatch(/listing/i);
  });

  it("requires a usable discount percentage", () => {
    expect(promotionFormProblem(valid({ percentOff: "" }))).toMatch(/percentage/i);
    expect(promotionFormProblem(valid({ percentOff: "abc" }))).toMatch(/percentage/i);
    expect(promotionFormProblem(valid({ percentOff: "0" }))).toMatch(/percentage/i);
  });

  it("enforces ORDER_DISCOUNT's spend threshold — and only for that type", () => {
    expect(
      promotionFormProblem(valid({ type: "ORDER_DISCOUNT", minSpend: "" })),
    ).toMatch(/minimum spend/i);
    expect(
      promotionFormProblem(valid({ type: "ORDER_DISCOUNT", minSpend: "fifty" })),
    ).toMatch(/minimum spend/i);
    // A junk minSpend must NOT block the types that don't use it.
    expect(
      promotionFormProblem(valid({ type: "VOLUME_DISCOUNT", minSpend: "junk", imageUrl: "" })),
    ).toBeNull();
  });

  it("enforces VOLUME_DISCOUNT's buy-N (eBay's floor is 2) — and only for that type", () => {
    expect(
      promotionFormProblem(valid({ type: "VOLUME_DISCOUNT", buyQuantity: "1", imageUrl: "" })),
    ).toMatch(/2 or more/i);
    // Buy-1 is meaningless as a volume discount but irrelevant to a coupon.
    expect(
      promotionFormProblem(valid({ type: "CODED_COUPON", buyQuantity: "1" })),
    ).toBeNull();
  });

  it("enforces the coupon code's 8–15 alphanumeric shape — and only for coupons", () => {
    expect(
      promotionFormProblem(valid({ type: "CODED_COUPON", couponCode: "SHORT" })),
    ).toMatch(/8/);
    expect(
      promotionFormProblem(valid({ type: "CODED_COUPON", couponCode: "HAS-A-DASH-IN" })),
    ).toMatch(/letters and numbers/i);
    expect(
      promotionFormProblem(valid({ type: "CODED_COUPON", couponCode: "WAYTOOLONGACODE12345" })),
    ).toMatch(/8/);
    // An invalid code must not block the types that never send one.
    expect(
      promotionFormProblem(valid({ type: "ORDER_DISCOUNT", couponCode: "!!" })),
    ).toBeNull();
  });

  it("requires a banner image exactly where eBay does", () => {
    expect(
      promotionFormProblem(valid({ type: "ORDER_DISCOUNT", imageUrl: "" })),
    ).toMatch(/banner image/i);
    expect(
      promotionFormProblem(valid({ type: "CODED_COUPON", imageUrl: "" })),
    ).toMatch(/banner image/i);
    // ...and nowhere else.
    expect(
      promotionFormProblem(valid({ type: "VOLUME_DISCOUNT", imageUrl: "" })),
    ).toBeNull();
  });
});
