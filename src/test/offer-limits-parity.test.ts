// OM-02: the web and edge copies of the Offers & Messages limits must agree.
//
// The edge enforces these and the page displays them. If they drift, the page
// either shows a rule the edge does not apply or lets the seller press Send on
// a value the edge will refuse. The projects cannot import each other, so this
// reads the edge file as text and compares every exported number.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as web from "@/lib/offer-limits";

const EDGE = readFileSync("services/edge-functions/src/lib/offer-limits.ts", "utf8");

function edgeConstants(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of EDGE.matchAll(/^export const ([A-Z_]+) = (\d+);/gm)) {
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

describe("offer-limits parity (OM-02)", () => {
  it("the edge file still exports the limits this test reads", () => {
    expect(Object.keys(edgeConstants()).sort()).toEqual([
      "EBAY_ID_MAX",
      "MEMBER_MESSAGE_MAX",
      "SELLER_RESPONSE_MAX",
      "SEND_OFFER_MAX_LISTINGS",
      "SEND_OFFER_MAX_PCT",
      "SEND_OFFER_MIN_PCT",
    ]);
  });

  it("every edge limit has the same value on the web", () => {
    const webNums = web as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(edgeConstants())) {
      expect(webNums[name], name).toBe(value);
    }
  });

  it("parseDiscountInput takes whole percents in range and substitutes nothing", () => {
    expect(web.parseDiscountInput("12")).toBe(12);
    expect(web.parseDiscountInput(" 60 ")).toBe(60);
    for (const bad of ["0", "0.4", "12.5", "61", "75", "", "abc", "-5"]) {
      expect(web.parseDiscountInput(bad), bad).toBeNull();
    }
  });
});
