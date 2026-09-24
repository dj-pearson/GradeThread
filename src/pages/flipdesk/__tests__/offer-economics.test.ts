// US-2941: the numbers on an offer row.
//
// Every one of these sits next to an Accept button, so the tests are weighted
// toward the refusals. "Unknown" must never render as zero: an item with no
// recorded cost has an unknown margin, and showing that as $0.00 or as 100% is
// a confident lie about money.
import { describe, it, expect } from "vitest";
import {
  formatMoney,
  grossMarginCents,
  marginPct,
  pctOfList,
  readExpiry,
  netMarginCents,
  netMarginPct,
  quickCounters,
  solvePriceForNet,
  validateCounter,
} from "@/pages/flipdesk/offer-economics";

describe("pctOfList", () => {
  it("reports the offer as a share of the asking price", () => {
    expect(pctOfList({ offerPrice: 70, listPrice: 100, itemCost: 20 })).toBe(70);
    expect(pctOfList({ offerPrice: 33.33, listPrice: 100, itemCost: null })).toBe(33.3);
  });

  it("is null when either price is missing or nonsensical", () => {
    expect(pctOfList({ offerPrice: null, listPrice: 100, itemCost: 20 })).toBeNull();
    expect(pctOfList({ offerPrice: 70, listPrice: null, itemCost: 20 })).toBeNull();
    expect(pctOfList({ offerPrice: 70, listPrice: 0, itemCost: 20 })).toBeNull();
    expect(pctOfList({ offerPrice: -5, listPrice: 100, itemCost: 20 })).toBeNull();
  });
});

describe("grossMarginCents / marginPct", () => {
  it("is the offer less what the item cost", () => {
    expect(grossMarginCents({ offerPrice: 70, listPrice: 100, itemCost: 20 })).toBe(5000);
    expect(marginPct({ offerPrice: 70, listPrice: 100, itemCost: 20 })).toBe(71.4);
  });

  it("goes NEGATIVE rather than clamping at zero", () => {
    // A loss has to read as a loss. Clamping would show an offer under cost as
    // break-even, which is the one thing this number exists to prevent.
    expect(grossMarginCents({ offerPrice: 15, listPrice: 100, itemCost: 20 })).toBe(-500);
    expect(marginPct({ offerPrice: 15, listPrice: 100, itemCost: 20 })).toBe(-33.3);
  });

  it("is NULL when the cost is unknown — never zero", () => {
    expect(grossMarginCents({ offerPrice: 70, listPrice: 100, itemCost: null })).toBeNull();
    expect(marginPct({ offerPrice: 70, listPrice: 100, itemCost: undefined })).toBeNull();
  });
});

describe("readExpiry", () => {
  const NOW = Date.parse("2026-08-27T12:00:00.000Z");
  const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

  it("counts in HOURS, because eBay offers commonly run 48", () => {
    // A day-granularity countdown spends half its life saying "1d left" about
    // something that expires before lunch.
    expect(readExpiry(inHours(6), NOW)).toMatchObject({ urgency: "today", label: "6h left" });
    // OM-05: 30h used to read "1d left", the same as 47h.
    expect(readExpiry(inHours(30), NOW)).toMatchObject({ urgency: "later", label: "30h left" });
    expect(readExpiry(inHours(47.5), NOW)?.label).toBe("47h left");
    expect(readExpiry(inHours(53), NOW)?.label).toBe("2d 5h left");
    expect(readExpiry(inHours(72), NOW)?.label).toBe("3d left");
  });

  it("calls out the last two hours", () => {
    expect(readExpiry(inHours(1), NOW)?.urgency).toBe("last_hours");
    expect(readExpiry(inHours(0.4), NOW)?.label).toBe("Under an hour left");
  });

  it("says expired rather than counting backwards", () => {
    expect(readExpiry(inHours(-3), NOW)).toMatchObject({ urgency: "expired", label: "Expired" });
  });

  it("returns null for a missing or unreadable date, never invented urgency", () => {
    expect(readExpiry(null, NOW)).toBeNull();
    expect(readExpiry(undefined, NOW)).toBeNull();
    expect(readExpiry("whenever", NOW)).toBeNull();
  });
});

describe("formatMoney", () => {
  it("keeps the sign on a loss", () => {
    expect(formatMoney(5000)).toBe("$50.00");
    expect(formatMoney(-500)).toBe("-$5.00");
    expect(formatMoney(5000, "GBP")).toBe("GBP 50.00");
  });
});

// ── US-3194: what actually lands ────────────────────────────────────────────
describe("netMarginCents", () => {
  it("subtracts eBay's cut, the postage and the grading fee", () => {
    // $36 offer on a $12 item. eBay takes 13.6% + $0.40 = $5.296. Postage
    // $8.30, grading $2.00. 36 - 5.296 - 12 - 8.30 - 2 = 8.404 -> 840 cents.
    expect(
      netMarginCents({
        offerPrice: 36,
        listPrice: 40,
        itemCost: 12,
        shippingCost: 8.3,
        gradingCost: 2,
      }),
    ).toBe(840);
  });

  it("finds an offer that is profitable gross and unprofitable net", () => {
    // This is the whole story: gross says the seller makes $3, net says the
    // sale costs them money, and the Accept button sits next to whichever one
    // is on screen.
    const input = {
      offerPrice: 15,
      listPrice: 20,
      itemCost: 12,
      shippingCost: 8.3,
      gradingCost: null,
    };
    expect(grossMarginCents(input)).toBe(300);
    expect(netMarginCents(input)).toBe(-774);
  });

  it("treats an absent shipping or grading figure as no cost, not unknown", () => {
    // 36 - 5.296 - 12 = 18.704 -> 1870 cents.
    expect(
      netMarginCents({ offerPrice: 36, listPrice: 40, itemCost: 12 }),
    ).toBe(1870);
  });

  it("returns null when the cost is unknown, exactly like the gross figure", () => {
    // Never a number beside an Accept button when an input is missing.
    expect(
      netMarginCents({ offerPrice: 36, listPrice: 40, itemCost: null }),
    ).toBeNull();
    expect(
      netMarginCents({ offerPrice: null, listPrice: 40, itemCost: 12 }),
    ).toBeNull();
  });
});

describe("netMarginPct", () => {
  it("expresses the net as a share of the offer", () => {
    expect(
      netMarginPct({
        offerPrice: 36,
        listPrice: 40,
        itemCost: 12,
        shippingCost: 8.3,
        gradingCost: 2,
      }),
    ).toBe(23.3);
  });

  it("is null whenever the net is", () => {
    expect(netMarginPct({ offerPrice: 36, listPrice: 40, itemCost: null })).toBeNull();
  });
});

describe("US-3194 lockstep with the rules engine", () => {
  it("the margin floor the rule applies is still the gross one, by design", () => {
    // decideOffer's floor is cost x (1 + pct), measured against the offer — the
    // GROSS relationship. The screen now shows net beside it, and the two are
    // different numbers on purpose; what must not drift is the gross figure the
    // rule and the screen share. If this fails, the rule and the row disagree
    // about the same offer.
    const input = { offerPrice: 36, listPrice: 40, itemCost: 12 };
    const cents = grossMarginCents(input);
    expect(cents).not.toBeNull();
    const grossFromScreen = cents! / 100;
    const grossFromRule = 36 - 12;
    expect(grossFromScreen).toBe(grossFromRule);
  });
});

// OM-07: the same bounds the edge enforces, shown before Send rather than as a
// generic eBay 502 after it.
describe("validateCounter", () => {
  const offer = { price: 40, listPriceCents: 5000, currency: "USD" };

  it("refuses a counter at or below the buyer's offer", () => {
    expect(validateCounter(offer, "40").ok).toBe(false);
    expect(validateCounter(offer, "39.99").reason).toMatch(/more than the buyer's \$40\.00/);
  });

  it("refuses a counter at or above the asking price", () => {
    const at = validateCounter(offer, "50");
    expect(at.ok).toBe(false);
    expect(at.reason).toMatch(/less than your \$50\.00 asking price/);
    expect(validateCounter(offer, "55").ok).toBe(false);
  });

  it("refuses three decimals rather than rounding them silently", () => {
    const r = validateCounter(offer, "45.125");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/dollars and cents/);
  });

  it("accepts a price between the two, in cents", () => {
    expect(validateCounter(offer, "45.50")).toEqual({ ok: true, cents: 4550, reason: null });
  });

  it("says nothing about an empty box", () => {
    expect(validateCounter(offer, "  ")).toEqual({ ok: false, cents: null, reason: null });
  });

  it("does not invent a bound it does not have", () => {
    expect(validateCounter({ price: null, listPriceCents: null }, "999").ok).toBe(true);
  });
});

// OM-15: counters priced from what the seller keeps.
describe("solvePriceForNet", () => {
  const cases = [
    { name: "cost only", e: { offerPrice: 40, listPrice: 50, itemCost: 12 } },
    {
      name: "cost + postage",
      e: { offerPrice: 40, listPrice: 50, itemCost: 12, shippingCost: 8.3 },
    },
    {
      name: "cost + postage + grading",
      e: { offerPrice: 90, listPrice: 120, itemCost: 35, shippingCost: 11, gradingCost: 4 },
    },
  ];
  for (const { name, e } of cases) {
    it(`inverts netMarginCents to within a cent (${name})`, () => {
      for (const target of [0, 500, 1234, 2500]) {
        const cents = solvePriceForNet(e, target)!;
        const net = netMarginCents({ ...e, offerPrice: cents / 100 })!;
        expect(net).toBeGreaterThanOrEqual(target);
        expect(net - target).toBeLessThanOrEqual(1);
      }
    });
  }

  it("is null when the cost is unknown", () => {
    expect(solvePriceForNet({ offerPrice: 40, listPrice: 50, itemCost: null }, 0)).toBeNull();
  });
});

describe("quickCounters", () => {
  // A $20 bid on a $60 ask, $12 cost, $8.30 postage: break-even is about
  // $23.96, so the bid loses money and the floor sits between bid and ask.
  const offer = {
    price: 20,
    listPriceCents: 6000,
    currency: "USD",
    itemCost: 12,
    shippingCost: 8.3,
  };

  it("offers split, ask minus 10% and the floor, each with what the seller keeps", () => {
    const chips = quickCounters(offer);
    expect(chips.map((c) => c.id)).toEqual(["split", "ask_minus_10", "floor"]);
    expect(chips.find((c) => c.id === "split")!.cents).toBe(4000);
    expect(chips.find((c) => c.id === "ask_minus_10")!.cents).toBe(5400);
    for (const c of chips) expect(c.netCents).not.toBeNull();
  });

  it("never puts the floor below break-even", () => {
    const floor = quickCounters(offer).find((c) => c.id === "floor")!;
    expect(floor.netCents!).toBeGreaterThanOrEqual(0);
    const breakEven = solvePriceForNet(
      { offerPrice: 20, listPrice: 60, itemCost: 12, shippingCost: 8.3 },
      0,
    )!;
    expect(floor.cents).toBeGreaterThanOrEqual(breakEven);
  });

  it("uses the rule's accept point when that is higher", () => {
    const floor = quickCounters(offer, { acceptAtPct: 85, marginFloorPct: 10 }).find(
      (c) => c.id === "floor",
    )!;
    expect(floor.cents).toBe(5100);
  });

  it("drops the floor chip when the bid already clears it", () => {
    // Accepting beats countering at a price lower than the bid.
    expect(quickCounters({ ...offer, price: 30 }).some((c) => c.id === "floor")).toBe(false);
  });

  it("drops a chip that would fall outside the valid range", () => {
    // Break-even here is above the asking price, so no floor chip can be sent.
    const chips = quickCounters({ ...offer, itemCost: 70 });
    expect(chips.some((c) => c.id === "floor")).toBe(false);
    // A bid above ask-minus-10% leaves that chip below the bid.
    const high = quickCounters({ ...offer, price: 56 });
    expect(high.some((c) => c.id === "ask_minus_10")).toBe(false);
  });
});
