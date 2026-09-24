// INV-7: bulk dialogs receive every selected row, not only the page in view.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listingIdsOf, selectedRowsFrom } from "@/pages/flipdesk/listings-selection";
import type { ItemFullRow } from "@/types/database";

const row = (id: string, listing_id: string | null = `L-${id}`) =>
  ({ id, listing_id }) as unknown as ItemFullRow;

describe("selectedRowsFrom", () => {
  it("returns rows from two pages, in selection order", () => {
    // page 2 is on screen; page 1's rows are the remembered ones.
    const actionItems = [row("p2-a"), row("p2-b"), row("p1-a"), row("p1-b", null)];
    const selected = new Set(["p1-a", "p2-b", "p1-b"]);
    const rows = selectedRowsFrom(actionItems, selected);
    expect(rows.map((r) => r.id)).toEqual(["p1-a", "p2-b", "p1-b"]);
    expect(listingIdsOf(rows)).toEqual(["L-p1-a", "L-p2-b"]);
  });
});

describe("the bulk dialogs are fed the whole selection", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/listings.tsx"), "utf8");
  const dialogs = src.slice(src.indexOf("<BulkRepriceDialog"), src.indexOf("function AggCard"));

  it("no dialog resolves ids against the current page only", () => {
    expect(dialogs).not.toMatch(/\bitems\.find\(/);
  });

  it.each(["BulkRepriceDialog", "BulkPromoteDialog", "BulkEditDialog"])(
    "%s gets selectedListingIds",
    (name) => {
      const block = dialogs.slice(dialogs.indexOf(`<${name}`));
      expect(block.slice(0, block.indexOf("/>"))).toContain("listingIds={selectedListingIds}");
    },
  );

  it("PrepareShipmentDialog gets selectedRows", () => {
    const block = dialogs.slice(dialogs.indexOf("<PrepareShipmentDialog"));
    expect(block.slice(0, block.indexOf("/>"))).toContain("items={selectedRows}");
  });
});
