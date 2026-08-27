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
