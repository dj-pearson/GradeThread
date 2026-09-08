import { describe, expect, it } from "vitest";
import {
  agedThresholdDays,
  capitalTiedUp,
  DEFAULT_AGED_THRESHOLD_DAYS,
  daysListed,
  isAged,
  MAX_AGED_THRESHOLD_DAYS,
  totalCapitalTiedUp,
} from "@/lib/aged-inventory";
import type { ItemFullRow } from "@/types/database";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const DAY = 86_400_000;

function listedDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

type AgedRow = Pick<ItemFullRow, "list_date" | "status" | "sale_date">;

function row(over: Partial<AgedRow> = {}): AgedRow {
  return {
    list_date: listedDaysAgo(90),
    status: "listed",
    sale_date: null,
    ...over,
  } as AgedRow;
}

describe("agedThresholdDays", () => {
  it("uses the seller's stored number", () => {
    expect(agedThresholdDays(30)).toBe(30);
    expect(agedThresholdDays(MAX_AGED_THRESHOLD_DAYS)).toBe(MAX_AGED_THRESHOLD_DAYS);
  });

  it("falls back to the default when nothing is stored", () => {
    expect(agedThresholdDays(null)).toBe(DEFAULT_AGED_THRESHOLD_DAYS);
    expect(agedThresholdDays(undefined)).toBe(DEFAULT_AGED_THRESHOLD_DAYS);
  });

  it("refuses a zero, which would mark every new listing aged on day one", () => {
    expect(agedThresholdDays(0)).toBe(DEFAULT_AGED_THRESHOLD_DAYS);
    expect(agedThresholdDays(-5)).toBe(DEFAULT_AGED_THRESHOLD_DAYS);
    expect(agedThresholdDays(MAX_AGED_THRESHOLD_DAYS + 1)).toBe(
      DEFAULT_AGED_THRESHOLD_DAYS,
    );
  });
});

describe("daysListed", () => {
  it("counts whole days since the listing went live", () => {
    expect(daysListed({ list_date: listedDaysAgo(45) } as ItemFullRow, NOW)).toBe(45);
  });

  it("is null for an item that was never listed, not zero", () => {
    // A drafted item has not been listed for no days; it has not been listed.
    expect(daysListed({ list_date: null } as ItemFullRow, NOW)).toBeNull();
  });

  it("is null for an unreadable date rather than counting from 1970", () => {
    expect(daysListed({ list_date: "someday" } as ItemFullRow, NOW)).toBeNull();
  });
});

describe("isAged", () => {
  it("includes a live listing past the threshold", () => {
    expect(isAged(row({ list_date: listedDaysAgo(61) }), 60, NOW)).toBe(true);
  });

  it("includes an item exactly at the threshold", () => {
    expect(isAged(row({ list_date: listedDaysAgo(60) }), 60, NOW)).toBe(true);
  });

  it("excludes one a day short of it", () => {
    expect(isAged(row({ list_date: listedDaysAgo(59) }), 60, NOW)).toBe(false);
  });

  it("excludes an item that already sold, however long it took", () => {
    // A 200-day sale is a fact for the analytics, not a thing to mark down.
    expect(
      isAged(
        row({ list_date: listedDaysAgo(200), status: "sold", sale_date: listedDaysAgo(1) }),
        60,
        NOW,
      ),
    ).toBe(false);
  });

  it("excludes a listed row that nonetheless carries a sale date", () => {
    expect(isAged(row({ sale_date: listedDaysAgo(2) }), 60, NOW)).toBe(false);
  });

  it("excludes anything not live, including a draft older than the threshold", () => {
    for (const status of ["drafted", "sourced", "archived", "shipped"]) {
      expect(
        isAged(row({ status: status as ItemFullRow["status"] }), 60, NOW),
      ).toBe(false);
    }
  });

  it("excludes an item that was never listed", () => {
    expect(isAged(row({ list_date: null }), 60, NOW)).toBe(false);
  });

  it("follows the seller's threshold, not the default", () => {
    const item = row({ list_date: listedDaysAgo(40) });
    expect(isAged(item, 30, NOW)).toBe(true);
    expect(isAged(item, 60, NOW)).toBe(false);
  });
});

describe("capital tied up", () => {
  it("reads the purchase price", () => {
    expect(capitalTiedUp({ purchase_price: 12.5 } as ItemFullRow)).toBe(12.5);
  });

  it("is null when no cost was recorded, never zero", () => {
    expect(capitalTiedUp({ purchase_price: null } as ItemFullRow)).toBeNull();
  });

  it("totals what it knows and counts what it does not", () => {
    const rows = [
      { purchase_price: 10 },
      { purchase_price: 5.5 },
      { purchase_price: null },
    ] as ItemFullRow[];
    expect(totalCapitalTiedUp(rows)).toEqual({ total: 15.5, unknownCount: 1 });
  });

  it("reports zero and no unknowns for an empty list", () => {
    expect(totalCapitalTiedUp([])).toEqual({ total: 0, unknownCount: 0 });
  });
});
