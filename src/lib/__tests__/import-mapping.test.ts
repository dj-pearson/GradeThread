import { describe, it, expect } from "vitest";
import { parseDate } from "@/lib/import-mapping";

// Fixed reference so year-inference for bare "M/D" values is deterministic.
const REF = new Date("2026-06-01T12:00:00Z");

describe("parseDate", () => {
  it("parses full ISO dates", () => {
    expect(parseDate("2026-01-18")).toBe("2026-01-18");
  });

  it("parses explicit M/D/YYYY and M/D/YY", () => {
    expect(parseDate("1/25/2026")).toBe("2026-01-25");
    expect(parseDate("1/25/26")).toBe("2026-01-25");
    expect(parseDate("01-25-2026")).toBe("2026-01-25");
  });

  // Regression: a year-less "M/D" used to hit `new Date("1/25")` which V8
  // resolves to 2001-01-25, producing absurd days_to_sell. It must now infer
  // the most recent occurrence at or before the reference date.
  it("infers the current year for bare M/D at or before the reference date", () => {
    expect(parseDate("1/25", REF)).toBe("2026-01-25");
    expect(parseDate("2/2", REF)).toBe("2026-02-02");
    expect(parseDate("3/11", REF)).toBe("2026-03-11");
    expect(parseDate("1/25", REF)).not.toContain("2001");
  });

  it("rolls a bare M/D that is still ahead of the reference back to last year", () => {
    // Dec 30 is after Jun 1, 2026 → most recent occurrence is 2025-12-30.
    expect(parseDate("12/30", REF)).toBe("2025-12-30");
  });

  it("rejects impossible calendar dates", () => {
    expect(parseDate("2/30", REF)).toBeNull();
    expect(parseDate("13/40", REF)).toBeNull();
  });

  it("returns null for empty/garbage", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
  });
});

describe("marketplace column (IMP-08)", () => {
  it("maps platform-ish headers to marketplace", async () => {
    const { guessField } = await import("@/lib/import-mapping");
    expect(guessField("Platform")).toBe("marketplace");
    expect(guessField("Marketplace")).toBe("marketplace");
    expect(guessField("Channel")).toBe("marketplace");
  });

  it("normalizes marketplace names and drops unknown ones", async () => {
    const { normalizeMarketplace } = await import("@/lib/import-mapping");
    expect(normalizeMarketplace("eBay")).toBe("ebay");
    expect(normalizeMarketplace("Facebook Marketplace")).toBe("facebook");
    expect(normalizeMarketplace("Posh")).toBe("poshmark");
    expect(normalizeMarketplace("Craigslist")).toBeNull();
  });
});

describe("IMP-11 mapping fixes", () => {
  it("reads a decimal comma in a comma column", async () => {
    const { parsePrice, detectDecimalComma } = await import("@/lib/import-mapping");
    const cells = ["12,50", "3,00", "1.234,56"];
    const dc = detectDecimalComma(cells);
    expect(dc).toBe(true);
    expect(parsePrice("12,50", { decimalComma: dc })).toBe(12.5);
    expect(parsePrice("1.234,56", { decimalComma: dc })).toBe(1234.56);
    // A US column keeps its thousands separators.
    expect(detectDecimalComma(["1,200", "12.50"])).toBe(false);
    expect(parsePrice("1,200")).toBe(1200);
  });

  it("reads accounting negatives", async () => {
    const { parsePrice } = await import("@/lib/import-mapping");
    expect(parsePrice("(4.00)")).toBe(-4);
    expect(parsePrice("$(12.50)")).toBe(12.5); // not wrapped: left alone
  });

  it("matches categories on whole words, last noun first", async () => {
    const { normalizeCategory } = await import("@/lib/import-mapping");
    expect(normalizeCategory("Cardigan")).toBe("clothing");
    expect(normalizeCategory("Bootcut Jeans")).toBe("clothing");
    expect(normalizeCategory("Dress Shoes")).toBe("shoes");
    expect(normalizeCategory("Baseball Card")).toBe("sports_cards");
    expect(normalizeCategory("Baseball Cap")).toBe("headwear");
    expect(normalizeCategory("Capri Pants")).toBe("clothing");
    expect(normalizeCategory("Leather Belt")).toBe("accessories");
    expect(normalizeCategory("Hoodie")).toBe("clothing");
    expect(normalizeCategory("sports_cards")).toBe("sports_cards");
    expect(normalizeCategory("Vase")).toBe("other");
  });

  it("reads a day-first date column", async () => {
    const { parseDate, detectDayFirst } = await import("@/lib/import-mapping");
    const cells = ["25/01/2026", "03/02/2026"];
    const df = detectDayFirst(cells);
    expect(df).toBe(true);
    expect(parseDate("25/01/2026", REF, { dayFirst: df })).toBe("2026-01-25");
    expect(parseDate("03/02/2026", REF, { dayFirst: df })).toBe("2026-02-03");
    expect(detectDayFirst(["01/25/2026", "03/02/2026"])).toBe(false);
  });

  it("reads Excel serial dates and pivots two-digit years", async () => {
    const { parseDate } = await import("@/lib/import-mapping");
    expect(parseDate("46023", REF)).toBe("2026-01-01");
    expect(parseDate("12/31/99", REF)).toBe("1999-12-31");
    expect(parseDate("1/5/26", REF)).toBe("2026-01-05");
  });

  it("maps marketplace status words", async () => {
    const { normalizeStatus } = await import("@/lib/import-mapping");
    expect(normalizeStatus("active")).toBe("listed");
    expect(normalizeStatus("Available")).toBe("listed");
    expect(normalizeStatus("For Sale")).toBe("listed");
    expect(normalizeStatus("In stock")).toBe("listed");
    expect(normalizeStatus("Sold out")).toBe("sold");
    expect(normalizeStatus("sold")).toBe("sold");
    expect(normalizeStatus("Unlisted")).toBe("drafted");
    expect(normalizeStatus("inactive")).toBe("drafted");
    expect(normalizeStatus("Listed")).toBe("listed");
  });

  it("maps common header synonyms", async () => {
    const { guessField } = await import("@/lib/import-mapping");
    expect(guessField("Price")).toBe("list_price");
    expect(guessField("Condition")).toBe("condition_notes");
    expect(guessField("COGS")).toBe("purchase_price");
    expect(guessField("Date Sold")).toBe("sale_date");
    expect(guessField("listed_at")).toBe("list_date");
    expect(guessField("Item #")).toBe("sku");
  });
});
