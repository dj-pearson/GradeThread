import { describe, expect, it } from "vitest";
import {
  fmtMoney,
  fmtMoneyShort,
  fmtSaleDate,
  itemLabel,
} from "@/lib/flipdesk-overview-format";

// DASH-13: money with grouping and the sign before the symbol, names for
// untitled items, and sale dates that do not slip a day.

describe("fmtMoney", () => {
  it("groups thousands and keeps cents", () => {
    expect(fmtMoney(48213.5)).toBe("$48,213.50");
  });

  it("puts the sign before the symbol", () => {
    expect(fmtMoney(-12.4)).toBe("-$12.40");
  });

  it("reads a missing number as zero", () => {
    expect(fmtMoney(null)).toBe("$0.00");
    expect(fmtMoney(Number.NaN)).toBe("$0.00");
  });
});

describe("fmtMoneyShort", () => {
  it("rounds small figures and compacts large ones", () => {
    expect(fmtMoneyShort(12.4)).toBe("$12");
    expect(fmtMoneyShort(48213.5)).toBe("$48.2K");
    expect(fmtMoneyShort(-1500)).toBe("-$1.5K");
  });
});

describe("itemLabel", () => {
  it("falls back to the brand, then to a name", () => {
    expect(itemLabel({ item_title: "Wool coat", brand: "Filson" })).toBe("Wool coat");
    expect(itemLabel({ item_title: "  ", brand: "Filson" })).toBe("Filson");
    expect(itemLabel({ item_title: null, brand: null })).toBe("Untitled item");
  });
});

describe("fmtSaleDate", () => {
  it("shows a bare calendar day as that day, in any time zone", () => {
    expect(fmtSaleDate("2026-09-01")).toBe(new Date(2026, 8, 1).toLocaleDateString());
  });

  it("is empty for nothing or junk", () => {
    expect(fmtSaleDate(null)).toBe("");
    expect(fmtSaleDate("not a date")).toBe("");
  });
});
