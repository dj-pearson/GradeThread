import { describe, expect, it, vi } from "vitest";
import { escapeCsvCell, downloadItemsCsv } from "../items-csv";
import { csvBlob, downloadBlob } from "@/lib/download";
import type { ItemFullRow } from "@/types/database";

vi.mock("@/lib/download", () => ({
  csvBlob: vi.fn((s: string) => ({ csv: s })),
  downloadBlob: vi.fn(),
}));

function makeItem(overrides: Partial<ItemFullRow> = {}): ItemFullRow {
  return { ...overrides } as unknown as ItemFullRow;
}

/** The CSV string handed to csvBlob by the most recent downloadItemsCsv call. */
function lastCsv(): string {
  const calls = (csvBlob as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[calls.length - 1]![0] as string;
}

describe("escapeCsvCell", () => {
  it("renders null and undefined as an empty cell", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("leaves clean values un-quoted", () => {
    expect(escapeCsvCell("Nike")).toBe("Nike");
    expect(escapeCsvCell(42)).toBe("42");
  });

  it("quotes values containing a comma, quote, or newline and doubles inner quotes", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("downloadItemsCsv", () => {
  it("writes a header row and triggers a dated download", () => {
    downloadItemsCsv([]);
    const csv = lastCsv();
    expect(csv.split("\n")[0]).toContain("Item Title");
    expect(downloadBlob).toHaveBeenCalled();
    const dlCalls = (downloadBlob as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const filename = dlCalls[dlCalls.length - 1]![1];
    expect(filename).toMatch(/^flipdesk-items-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("sorts numbered items ascending, then un-numbered drafts alphabetically by title", () => {
    const rows = [
      makeItem({ item_number: "10", item_title: "Ten" }),
      makeItem({ item_number: null, item_title: "Zebra draft" }),
      makeItem({ item_number: "2", item_title: "Two" }),
      makeItem({ item_number: "", item_title: "Apple draft" }),
    ];
    downloadItemsCsv(rows);
    const dataRows = lastCsv().split("\n").slice(1);
    const titles = dataRows.map((r) => r.split(",")[2]);
    expect(titles).toEqual(["Two", "Ten", "Apple draft", "Zebra draft"]);
  });

  it("blanks sale-derived money columns for an unsold item but fills them once sold", () => {
    const unsold = makeItem({
      item_number: "1",
      item_title: "Unsold",
      fees: 3,
      net_profit: 9,
      payout: 40,
      sale_date: null,
      sale_price: null,
    });
    downloadItemsCsv([unsold]);
    let cells = lastCsv().split("\n")[1]!.split(",");
    // Net Profit is column index 21 in the header order.
    expect(cells[21]).toBe(""); // blanked because unsold

    const sold = makeItem({
      item_number: "1",
      item_title: "Sold",
      net_profit: 9,
      sale_date: "2026-01-05T12:00:00Z",
      sale_price: 50,
    });
    downloadItemsCsv([sold]);
    cells = lastCsv().split("\n")[1]!.split(",");
    expect(cells[21]).toBe("9"); // filled because sold
    expect(cells[16]).toBe("2026-01-05"); // Sale Date sliced to yyyy-mm-dd
  });
});
