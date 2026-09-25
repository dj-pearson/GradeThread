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

describe("IMP-12 validation summary", () => {
  it("counts blank titles, bad dates, bad prices and duplicate SKUs with row numbers", async () => {
    const { buildMapped, buildImportPayload, validateImportRows, importableRows, guessField } =
      await import("@/lib/import-mapping");
    const headers = ["Item #", "Title", "Purchase Date", "Price", "Status", "Category"];
    const mapping = headers.map(guessField);
    const rows = [
      ["A1", "Tee", "2026-01-02", "10", "listed", "Shirt"],
      ["A2", "", "2026-01-02", "10", "", ""],
      ["A3", "", "", "", "", ""],
      ["A4", "  ", "", "", "", ""],
      ["A5", "Jeans", "not a date", "12", "", ""],
      ["A6", "Hat", "13/45/2026", "abc", "weird", "Vase"],
      ["A1", "Tee again", "", "", "", ""],
    ];
    const mapped = rows.map((r) => buildMapped(r, headers, mapping));
    const payload = buildImportPayload(mapped, undefined, new Date("2026-06-01T12:00:00Z"));
    const v = validateImportRows(mapped, payload, mapping);
    expect(v.total).toBe(7);
    expect(v.noTitle).toEqual([3, 4, 5]);
    expect(v.willImport).toBe(4);
    expect(v.badDate).toEqual([6, 7]);
    expect(v.badPrice).toEqual([7]);
    expect(v.unknownStatus).toEqual([7]);
    expect(v.fellToOther).toEqual([7]);
    expect(v.duplicateSkus).toEqual([8]);
    expect(v.overCap).toBe(false);
    // The button count is what the server will report as total_rows.
    expect(importableRows(payload)).toHaveLength(v.willImport);
  });

  it("flags a file over the row cap before any POST, and can take the first 5,000", async () => {
    const { buildImportPayload, validateImportRows, importableRows, MAX_IMPORT_ROWS } =
      await import("@/lib/import-mapping");
    const mapped = Array.from({ length: 6000 }, (_, i) => ({ title: `T${i}` }));
    const payload = buildImportPayload(mapped);
    const v = validateImportRows(mapped, payload, ["title"]);
    expect(v.overCap).toBe(true);
    expect(importableRows(payload)).toHaveLength(MAX_IMPORT_ROWS);
  });

  it("warns when two columns map to the same field", async () => {
    const { validateImportRows } = await import("@/lib/import-mapping");
    const v = validateImportRows([], [], ["title", "brand", "brand", "skip", "skip"]);
    expect(v.duplicateFields).toEqual(["brand"]);
  });

  it("MAX_IMPORT_ROWS matches the edge constant", async () => {
    const { readFileSync } = await import("node:fs");
    const { MAX_IMPORT_ROWS } = await import("@/lib/import-mapping");
    const edge = readFileSync("services/edge-functions/src/lib/inventory-import.ts", "utf8");
    const m = /export const MAX_IMPORT_ROWS = (\d+);/.exec(edge);
    expect(Number(m?.[1])).toBe(MAX_IMPORT_ROWS);
  });

  it("uses per-column hints when building the payload", async () => {
    const { buildImportPayload } = await import("@/lib/import-mapping");
    const [a, b] = buildImportPayload(
      [
        { title: "A", purchase_price: "12,50", purchase_date: "25/01/2026" },
        { title: "B", purchase_price: "3,00", purchase_date: "02/03/2026" },
      ],
      undefined,
      new Date("2026-06-01T12:00:00Z"),
    );
    expect(a!.acquired_price).toBe(12.5);
    expect(a!.acquired_date).toBe("2026-01-25");
    expect(b!.acquired_date).toBe("2026-03-02");
  });
});

describe("failed rows download (IMP-15)", () => {
  it("holds exactly the failed rows, their original columns, and an Error column", async () => {
    const { failedRowsCsv } = await import("@/lib/import-mapping");
    const headers = ["Item #", "Title", "Price"];
    const rows = [
      ["A1", "Tee", "10"],
      ["A2", "Jeans", "12"],
      ["A3", "Hat", "x"],
      ["A4", "=HYPERLINK(1)", "4"],
      ["A5", "Coat", "9"],
    ];
    const { csv, count } = failedRowsCsv(headers, rows, [
      { row: 0, message: 'Could not create the source "Goodwill".' },
      { row: 4, message: "A number in this row couldn't be read." },
      { row: 3, message: "The date isn't a real date." },
      { row: 5, message: "This row couldn't be saved." },
    ]);
    expect(count).toBe(3);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Item #,Title,Price,Error");
    expect(lines[1]).toBe("A2,Jeans,12,The date isn't a real date.");
    expect(lines[2]).toBe("A3,Hat,x,A number in this row couldn't be read.");
    // A formula cell is neutralized on the way out.
    expect(lines[3]).toContain("'=HYPERLINK(1)");
  });
});
