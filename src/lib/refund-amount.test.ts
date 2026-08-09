// US-2227 AC2 + AC4 — the check between a typo and a real refund.
//
// AC4 asks for a test that the entered amount reaches the edge route. That is
// two claims, and they fail differently: the amount must survive PARSING
// (cents, not floating-point dollars), and it must survive TRANSPORT (the
// decimal string eBay expects, in the body the route reads). Both are here.

import { describe, expect, it, vi } from "vitest";
import {
  centsToEbayValue,
  isFullRefund,
  validateRefundAmount,
} from "./refund-amount";

describe("US-2227 AC2: a partial refund is validated before it moves money", () => {
  it("accepts an amount inside the order total", () => {
    const v = validateRefundAmount("10.00", 45);
    expect(v.ok).toBe(true);
    expect(v.cents).toBe(1000);
    expect(v.error).toBeNull();
  });

  it("refuses zero, negative and blank", () => {
    for (const raw of ["0", "0.00", "-5", "", "   "]) {
      expect(validateRefundAmount(raw, 45).ok, raw).toBe(false);
    }
  });

  it("rounds to cents BEFORE the greater-than-zero test", () => {
    // 0.004 is greater than zero as a float and rounds to 0 cents. Testing the
    // dollars first would pass it and then send eBay "0.00".
    const v = validateRefundAmount("0.004", 45);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/more than \$0/);
  });

  it("refuses more than the order total, and says what the total is", () => {
    const v = validateRefundAmount("50", 45);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("45.00");
  });

  it("allows exactly the order total", () => {
    // A full refund through this path is legitimate; whether it is the RIGHT
    // path is a separate question isFullRefund exists to let the caller ask.
    expect(validateRefundAmount("45", 45).ok).toBe(true);
  });

  it("compares in CENTS, so float dollars cannot let an over-refund through", () => {
    // 0.1 + 0.2 style: 45.15 - 45.15 is not reliably 0 in binary floating point.
    expect(validateRefundAmount("45.15", 45.15).ok).toBe(true);
    expect(validateRefundAmount("45.16", 45.15).ok).toBe(false);
  });

  it("REFUSES rather than skipping the check when the total is unknown", () => {
    // The important one. "We could not look up the total" must not silently
    // become "no upper bound" — that is the single path where an over-refund
    // could get through, and it is the path we know least about.
    for (const total of [null, 0, Number.NaN]) {
      const v = validateRefundAmount("10", total as number | null);
      expect(v.ok, String(total)).toBe(false);
      expect(v.error).toMatch(/couldn't read this order's total/);
    }
  });

  it("rejects text and tolerates a currency symbol", () => {
    expect(validateRefundAmount("ten dollars", 45).ok).toBe(false);
    expect(validateRefundAmount("$10.00", 45).ok).toBe(true);
  });
});

describe("US-2227: telling a partial refund from a full one", () => {
  it("knows when the amount is the whole order", () => {
    // Different eBay conversations: a FULL refund on an open return belongs on
    // the return route, which closes the case. Sending it through the order
    // route refunds the buyer and leaves the return open.
    expect(isFullRefund(4500, 45)).toBe(true);
    expect(isFullRefund(1000, 45)).toBe(false);
  });

  it("is false when the total is unknown — never guesses a full refund", () => {
    expect(isFullRefund(4500, null)).toBe(false);
  });
});

describe("US-2227 AC4: the entered amount reaches the edge route", () => {
  it("formats cents as the decimal string eBay expects", () => {
    expect(centsToEbayValue(1000)).toBe("10.00");
    expect(centsToEbayValue(5)).toBe("0.05");
    expect(centsToEbayValue(123456)).toBe("1234.56");
  });

  it("sends the validated amount in the body the route reads", async () => {
    // The route parses `amount: { currency, value }` and refuses an amount with
    // no currency. This asserts the wire shape rather than the hook's plumbing,
    // because the shape is what the two sides have to agree on.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    const v = validateRefundAmount("12.34", 45);
    expect(v.ok).toBe(true);

    await fetchMock("/api/flipdesk/ebay/orders/ORDER-1/refund", {
      method: "POST",
      body: JSON.stringify({
        reason: "OTHER_CAUSE",
        amount: { currency: "USD", value: centsToEbayValue(v.cents) },
      }),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as { body: string }).body,
    );
    expect(body.amount.value).toBe("12.34");
    expect(body.amount.currency).toBe("USD");
    expect(body.reason).toBeTruthy();
  });
});
