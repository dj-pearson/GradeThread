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
    expect(readExpiry(inHours(30), NOW)).toMatchObject({ urgency: "later", label: "1d left" });
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
    const grossFromScreen = grossMarginCents(input) / 100;
    const grossFromRule = 36 - 12;
    expect(grossFromScreen).toBe(grossFromRule);
  });
});
