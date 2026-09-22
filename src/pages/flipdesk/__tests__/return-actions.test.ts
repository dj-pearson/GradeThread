// US-3466: return buttons follow eBay's sellerAvailableOptions.
import { describe, it, expect } from "vitest";
import {
  returnAllows,
  returnWaitingOnBuyer,
} from "@/pages/flipdesk/post-sale-state";

describe("returnAllows", () => {
  it("offers only what eBay lists", () => {
    const actions = ["SELLER_APPROVE_REQUEST", "SELLER_DECLINE_REQUEST", "SELLER_SEND_MESSAGE"];
    expect(returnAllows(actions, "approve")).toBe(true);
    expect(returnAllows(actions, "decline")).toBe(true);
    expect(returnAllows(actions, "message")).toBe(true);
    expect(returnAllows(actions, "refund")).toBe(false);
    expect(returnAllows(actions, "partial")).toBe(false);
    expect(returnAllows(actions, "received")).toBe(false);
  });

  it("an empty list offers nothing: the closed return that still showed Refund", () => {
    for (const a of ["approve", "decline", "refund", "partial", "received", "message"] as const) {
      expect(returnAllows([], a)).toBe(false);
    }
  });

  it("no list at all falls back to offering everything", () => {
    expect(returnAllows(null, "refund")).toBe(true);
    expect(returnAllows(undefined, "approve")).toBe(true);
  });

  it("a retry-refund counts as refund", () => {
    expect(returnAllows(["SELLER_RETRY_REFUND"], "refund")).toBe(true);
  });
});

describe("returnWaitingOnBuyer", () => {
  it("is true only when eBay sent a list with nothing for the seller", () => {
    expect(returnWaitingOnBuyer([])).toBe(true);
    expect(returnWaitingOnBuyer(["SELLER_PRINT_SHIPPING_LABEL"])).toBe(true);
    expect(returnWaitingOnBuyer(["SELLER_ISSUE_REFUND"])).toBe(false);
    expect(returnWaitingOnBuyer(null)).toBe(false);
  });
});
