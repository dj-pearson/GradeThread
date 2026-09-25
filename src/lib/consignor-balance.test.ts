import { describe, expect, it } from "vitest";
import { consignorBalance, splitExample } from "@/lib/consignor-balance";

describe("consignorBalance (C9)", () => {
  it("takes pending payouts out of what is available", () => {
    expect(
      consignorBalance({ consignor_share: 50, payouts_paid: 0, payouts_pending: 50 }),
    ).toEqual({ available: 0, pending: 50, overpaid: 0 });
    expect(
      consignorBalance({ consignor_share: 100, payouts_paid: 20, payouts_pending: 30 }),
    ).toEqual({ available: 50, pending: 30, overpaid: 0 });
  });

  it("reports an overpaid consignor instead of clamping to zero", () => {
    expect(
      consignorBalance({ consignor_share: 40, payouts_paid: 55.5, payouts_pending: 0 }),
    ).toEqual({ available: 0, pending: 0, overpaid: 15.5 });
  });

  it("gives zeros for a missing P&L row", () => {
    expect(consignorBalance(null)).toEqual({ available: 0, pending: 0, overpaid: 0 });
    expect(consignorBalance(undefined)).toEqual({ available: 0, pending: 0, overpaid: 0 });
  });

  it("does its sums in cents, so float noise never shows up", () => {
    // 0.3 - 0.1 - 0.1 is 0.09999999999999998 in floats.
    expect(
      consignorBalance({ consignor_share: 0.3, payouts_paid: 0.1, payouts_pending: 0.1 })
        .available,
    ).toBe(0.1);
  });

  it("treats numeric strings from the view as numbers", () => {
    expect(
      consignorBalance({
        consignor_share: "12.34" as unknown as number,
        payouts_paid: "2.34" as unknown as number,
        payouts_pending: "0" as unknown as number,
      }),
    ).toEqual({ available: 10, pending: 0, overpaid: 0 });
  });
});

describe("splitExample (C12)", () => {
  it("works the split on net, $100 minus $13 fees", () => {
    expect(splitExample(60)).toBe("On a $100 sale with $13 fees, they get $52.20.");
    expect(splitExample(100)).toBe("On a $100 sale with $13 fees, they get $87.00.");
  });
  it("clamps nonsense to the 0-100 range", () => {
    expect(splitExample(NaN)).toBe("On a $100 sale with $13 fees, they get $0.00.");
    expect(splitExample(150)).toBe("On a $100 sale with $13 fees, they get $87.00.");
  });
});
